/**
 * Reusable fixture and serialization test harness for web deploy safety (U2.3a-ii.2).
 * Composes committed createPrivateSandbox/runPython lifecycle without reimplementation.
 * Single-user, sequential test scope; truthful non-raceproof assumptions.
 */
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize, join } from 'node:path'
import { type PrivateSandbox } from './web-private-sandbox'

export const FIXTURE_CANDIDATE_IMAGE_ID = 'sha256:' + '1'.repeat(64)
export const FIXTURE_CURRENT_IMAGE_ID = 'sha256:' + '2'.repeat(64)
export const FIXTURE_DOCKER_ENDPOINT = 'unix:///var/run/docker.sock'
export const FIXTURE_PROJECT = 'crm'
export const FIXTURE_NETWORKS = ['net_a']
export const FIXTURE_PORT = { target: 3000, published: 3020, host_ip: '127.0.0.1', protocol: 'tcp' }

export interface BundleStateFixture {
  bundleDir: string
  manifestSha256: string
  state: Record<string, string>
  serializedState: string
  expectedArgs: {
    expected_root: string
    expected_endpoint: string
    expected_project: string
    expected_networks: string[]
  }
}

export interface BundleFixtureOptions {
  subdir?: string
  networks?: string[]
  composeProject?: string
}

export const STATIC_BUNDLE_CREATION_SCRIPT = `
import sys, json, os
import scripts.web_only_bundle_writer as bw
import scripts.web_only_state as ws
import scripts.web_only_state_serializer as wss

cfg = json.loads(sys.argv[1])
target, project, nets = cfg["target"], cfg["project"], cfg["networks"]
cand_img, curr_img = cfg["cand_img"], cfg["curr_img"]
endpoint, sb_dir = cfg["endpoint"], cfg["sb_dir"]

p = [{"target": 3000, "published": 3020, "host_ip": "127.0.0.1", "protocol": "tcp"}]
svc_nets = {n: ({"aliases": ["web"]} if idx == 0 else {}) for idx, n in enumerate(nets)}
top_nets = {n: {"name": n, "external": True} for n in nets}
cand = {"services": {"web": {"image": cand_img, "ports": p, "networks": svc_nets}}, "networks": top_nets}
roll = {"services": {"web": {"image": curr_img, "ports": p, "networks": svc_nets}}, "networks": top_nets}
bdir = os.path.join(target, "bundle")

meta = {
    "project": project, "service": "web",
    "candidate_image_id": cand_img, "current_image_id": curr_img,
    "ports": p[0], "networks": nets, "container_id": "a" * 64, "container_name": "crm-web"
}

res = bw.write_effective_bundle(
    bdir, (json.dumps(cand) + "\\n").encode("utf-8"),
    (json.dumps(roll) + "\\n").encode("utf-8"), meta
)

st = {
    "STATE_VERSION": "2", "DEPLOY_MODE": "web-only", "BUNDLE_DIR": bdir,
    "MANIFEST_SHA256": res["manifest_sha256"], "COMPOSE_PROJECT": project,
    "OPERATIONAL_ROOT": sb_dir, "DOCKER_ENDPOINT": endpoint,
    "EXPECTED_NETWORKS": json.dumps(nets), "PREVIOUS_ID": curr_img, "DEPLOYED_ID": cand_img
}

serialized = wss.serialize_v2_release_env(st)
expected_args = {
    "expected_root": sb_dir, "expected_endpoint": endpoint,
    "expected_project": project, "expected_networks": nets
}

ws.validate_v2_bundle_state(st, **expected_args)

sys.stdout.write(json.dumps({
    "bundleDir": bdir, "manifestSha256": res["manifest_sha256"],
    "state": st, "serializedState": serialized, "expectedArgs": expected_args
}))
`

export function createBundleFixture(
  sb: PrivateSandbox,
  options?: BundleFixtureOptions | string
): BundleStateFixture {
  if (!sb || typeof sb.dir !== 'string' || typeof sb.mkdir !== 'function' || typeof sb.runPython !== 'function') {
    throw new Error('Valid PrivateSandbox instance is required')
  }

  const ownedRoot = sb.dir
  let lst
  try {
    lst = lstatSync(ownedRoot)
  } catch {
    throw new Error(`Sandbox root does not exist: ${ownedRoot}`)
  }
  if (lst.isSymbolicLink()) throw new Error(`Sandbox root is a symlink: ${ownedRoot}`)
  if (sb.rootDev !== undefined && sb.rootIno !== undefined) {
    if (lst.dev !== sb.rootDev || lst.ino !== sb.rootIno) {
      throw new Error(`Sandbox root identity changed (dev/ino mismatch): ${ownedRoot}`)
    }
  }
  if (!lst.isDirectory()) throw new Error(`Sandbox root is not a directory: ${ownedRoot}`)
  if (realpathSync(ownedRoot) !== ownedRoot) {
    throw new Error(`Sandbox root must be canonical without symlinks: ${ownedRoot}`)
  }

  const opts: BundleFixtureOptions = typeof options === 'string' ? { subdir: options } : (options ?? {})
  let targetDir = ownedRoot

  if (opts.subdir) {
    const rawSubdir = opts.subdir
    if (isAbsolute(rawSubdir)) throw new Error(`Subdir must be relative: ${rawSubdir}`)
    const norm = normalize(rawSubdir)
    if (norm === '.' || norm === '..' || norm.startsWith('../') || norm.includes('/../')) {
      throw new Error(`Subdir must stay inside sandbox: ${rawSubdir}`)
    }
    let cur = ownedRoot
    for (const seg of norm.split('/').filter(Boolean)) {
      cur = join(cur, seg)
      try {
        if (lstatSync(cur).isSymbolicLink()) throw new Error(`Symlink component encountered: ${cur}`)
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err
      }
    }
    targetDir = sb.mkdir(norm)
  }

  const targetStat = lstatSync(targetDir)
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`Target directory invalid: ${targetDir}`)
  }
  const realTarget = realpathSync(targetDir)
  if (realTarget !== ownedRoot && !realTarget.startsWith(ownedRoot + '/')) {
    throw new Error(`Target escapes sandbox root: ${targetDir}`)
  }

  const cfg = {
    target: targetDir,
    project: opts.composeProject ?? FIXTURE_PROJECT,
    networks: opts.networks ?? FIXTURE_NETWORKS,
    cand_img: FIXTURE_CANDIDATE_IMAGE_ID,
    curr_img: FIXTURE_CURRENT_IMAGE_ID,
    endpoint: FIXTURE_DOCKER_ENDPOINT,
    sb_dir: ownedRoot,
  }

  const res = sb.runPython(STATIC_BUNDLE_CREATION_SCRIPT, { args: [JSON.stringify(cfg)] })
  if (res.status !== 0) throw new Error(`Bundle fixture creation failed: ${res.stderr}`)
  return JSON.parse(res.stdout) as BundleStateFixture
}
