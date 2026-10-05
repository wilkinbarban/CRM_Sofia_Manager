import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, chmodSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const PYTHON_BIN = '/usr/bin/python3'
let tempDir: string | null = null

function getSandbox(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'state-validator-'))
  chmodSync(tempDir, 0o700)
  return tempDir
}

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

function expectPython(code: string, expectedStdout: string) {
  const ret = spawnSync(PYTHON_BIN, ['-B', '-c', code], {
    env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '.' },
    encoding: 'utf8',
  })
  expect(ret.status).toBe(0)
  expect(ret.stdout.trim()).toBe(expectedStdout)
}

const FIXTURE = `
import json, os, hashlib, scripts.web_only_bundle_writer as bw, scripts.web_only_state as ws
CAND_IMG, CURR_IMG = "sha256:" + "1" * 64, "sha256:" + "2" * 64
def make_bundle(base, nets=None, cand_env=None):
    if nets is None: nets = ["net_a"]
    svc_nets = {n: ({"aliases": ["web"]} if idx == 0 else {}) for idx, n in enumerate(nets)}
    top_nets = {n: {"name": n, "external": True} for n in nets}
    web_c = {"image": CAND_IMG, "ports": [{"target": 3000, "published": 3020, "host_ip": "127.0.0.1", "protocol": "tcp"}], "networks": svc_nets}
    if cand_env: web_c["environment"] = cand_env
    cand = {"services": {"web": web_c}, "networks": top_nets}
    roll = {"services": {"web": {"image": CURR_IMG, "ports": [{"target": 3000, "published": 3020, "host_ip": "127.0.0.1", "protocol": "tcp"}], "networks": svc_nets}}, "networks": top_nets}
    bdir = os.path.join(base, "bundle")
    meta = {"project": "crm", "service": "web", "candidate_image_id": CAND_IMG, "current_image_id": CURR_IMG, "ports": {"target": 3000, "published": 3020, "host_ip": "127.0.0.1", "protocol": "tcp"}, "networks": nets, "container_id": "a"*64, "container_name": "crm-web"}
    res = bw.write_effective_bundle(bdir, (json.dumps(cand) + "\\n").encode(), (json.dumps(roll) + "\\n").encode(), meta)
    return bdir, res
def make_state(sb, bdir, res, net_json='["net_a"]'):
    return {
        "STATE_VERSION": "2", "DEPLOY_MODE": "web-only", "BUNDLE_DIR": bdir,
        "MANIFEST_SHA256": res["manifest_sha256"], "COMPOSE_PROJECT": "crm",
        "OPERATIONAL_ROOT": sb, "DOCKER_ENDPOINT": "unix:///var/run/docker.sock",
        "EXPECTED_NETWORKS": net_json, "PREVIOUS_ID": CURR_IMG, "DEPLOYED_ID": CAND_IMG,
    }
`

describe('web-only-state U2.2a inert pure typed v2 binding validator', () => {
  it('validates 0700/0600 writer bundle with valid state and redacts env', () => {
    const sb = getSandbox()
    expectPython(`${FIXTURE}
root_dir = os.path.join("${sb}", "root")
os.mkdir(root_dir, 0o700)
bdir, res = make_bundle("${sb}", cand_env={"SECRET_TOKEN": "priv123"})
state = make_state(root_dir, bdir, res)
out = ws.validate_v2_bundle_state(state, expected_root=root_dir, expected_endpoint="unix:///var/run/docker.sock", expected_project="crm", expected_networks=["net_a"])
assert out["status"] == "ok" and out["bundle_dir"] == bdir and bdir != root_dir
assert out["candidate_image_id"] == CAND_IMG and out["current_image_id"] == CURR_IMG
assert "SECRET_TOKEN" not in str(out) and "priv123" not in str(out)
print("SUCCESS_VALID_STATE")`, 'SUCCESS_VALID_STATE')
  })

  it('validates state network order independence against expected set', () => {
    const sb = getSandbox()
    expectPython(`${FIXTURE}
bdir, res = make_bundle("${sb}", nets=["net_a", "net_b"])
state = make_state("${sb}", bdir, res, net_json='["net_b", "net_a"]')
out = ws.validate_v2_bundle_state(state, expected_root="${sb}", expected_endpoint="unix:///var/run/docker.sock", expected_project="crm", expected_networks={"net_a", "net_b"})
assert out["status"] == "ok" and set(out["networks"]) == {"net_a", "net_b"}
print("SUCCESS_NETWORK_SET")`, 'SUCCESS_NETWORK_SET')
  })

  it('asserts sentinel mock is never called when state binding is invalid', () => {
    const sb = getSandbox()
    expectPython(`${FIXTURE}
calls = []
ws.validate_effective_bundle = lambda *a, **k: calls.append(1) or {}
bdir, res = make_bundle("${sb}")
sym, dang, anc = os.path.join("${sb}", "sym"), os.path.join("${sb}", "dang"), os.path.join("${sb}", "anc")
os.symlink(bdir, sym); os.symlink(os.path.join("${sb}", "none"), dang); os.symlink("${sb}", anc)
invalid_states = [
    {"STATE_VERSION": "1"},
    {"STATE_VERSION": 2},
    {"STATE_VERSION": True},
    {"DEPLOY_MODE": "all"},
    make_state("${sb}", bdir, res, net_json='["other"]'),
    {**make_state("${sb}", bdir, res), "DOCKER_ENDPOINT": "unix:///var/run/other.sock"},
    {**make_state("${sb}", bdir, res), "COMPOSE_PROJECT": "other"},
    {**make_state("${sb}", bdir, res), "OPERATIONAL_ROOT": "/other"},
    {**make_state("${sb}", bdir, res), "MANIFEST_SHA256": "bad_sha"},
    {**make_state("${sb}", bdir, res), "DEPLOYED_ID": "bad_img"},
    {**make_state("${sb}", bdir, res), "EXPECTED_NETWORKS": '["a"], "extra": 1'},
    *[make_state("${sb}", b, res) for b in ["rel/b", bdir + "/../bundle", bdir + "/.", bdir + "/", "/", sym, dang, os.path.join(anc, "bundle")]],
]
for s in invalid_states:
    try:
        ws.validate_v2_bundle_state(s, expected_root="${sb}", expected_endpoint="unix:///var/run/docker.sock", expected_project="crm", expected_networks=["net_a"])
    except ValueError:
        pass
assert len(calls) == 0, f"sentinel called {len(calls)} times on invalid bindings"
print("SENTINEL_NEVER_CALLED")`, 'SENTINEL_NEVER_CALLED')
  })

  it.each([
    ['not a mapping', '"not-map"'],
    ['missing required key', '{"STATE_VERSION": "2"}'],
    ['STATE_VERSION integer', '{**make_state(sb, bdir, res), "STATE_VERSION": 2}'],
    ['STATE_VERSION boolean', '{**make_state(sb, bdir, res), "STATE_VERSION": True}'],
    ['STATE_VERSION legacy 1', '{**make_state(sb, bdir, res), "STATE_VERSION": "1"}'],
    ['DEPLOY_MODE wrong', '{**make_state(sb, bdir, res), "DEPLOY_MODE": "all"}'],
    ['DEPLOY_MODE bool', '{**make_state(sb, bdir, res), "DEPLOY_MODE": False}'],
    ['empty BUNDLE_DIR', '{**make_state(sb, bdir, res), "BUNDLE_DIR": "   "}'],
    ['non-hex64 MANIFEST_SHA256', '{**make_state(sb, bdir, res), "MANIFEST_SHA256": "x"*64}'],
    ['short MANIFEST_SHA256', '{**make_state(sb, bdir, res), "MANIFEST_SHA256": "a"*63}'],
    ['invalid DEPLOYED_ID', '{**make_state(sb, bdir, res), "DEPLOYED_ID": "a"*64}'],
    ['invalid PREVIOUS_ID', '{**make_state(sb, bdir, res), "PREVIOUS_ID": "docker.io/img:latest"}'],
    ['relative OPERATIONAL_ROOT', '{**make_state(sb, bdir, res), "OPERATIONAL_ROOT": "./rel"}'],
    ['trailing slash OPERATIONAL_ROOT', '{**make_state(sb, bdir, res), "OPERATIONAL_ROOT": sb + "/"}'],
    ['dot dot OPERATIONAL_ROOT', '{**make_state(sb, bdir, res), "OPERATIONAL_ROOT": sb + "/../other"}'],
    ['OPERATIONAL_ROOT mismatch', '{**make_state(sb, bdir, res), "OPERATIONAL_ROOT": "/tmp"}'],
    ['DOCKER_ENDPOINT mismatch', '{**make_state(sb, bdir, res), "DOCKER_ENDPOINT": "unix:///var/run/custom.sock"}'],
    ['COMPOSE_PROJECT mismatch', '{**make_state(sb, bdir, res), "COMPOSE_PROJECT": "wrong_project"}'],
  ])('rejects invalid state fields: %s', (_, expr) => {
    const sb = getSandbox()
    expectPython(`${FIXTURE}
sb = "${sb}"
bdir, res = make_bundle(sb)
try:
    ws.validate_v2_bundle_state(${expr}, expected_root=sb, expected_endpoint="unix:///var/run/docker.sock", expected_project="crm", expected_networks=["net_a"])
    print("FAILED")
except ValueError:
    print("REJECTED_STATE")`, 'REJECTED_STATE')
  })

  it.each([
    ['relative expected_root', '"rel/path"', '"unix:///var/run/docker.sock"', '"crm"', '["net_a"]'],
    ['trailing slash expected_root', 'sb + "/"', '"unix:///var/run/docker.sock"', '"crm"', '["net_a"]'],
    ['non-existent expected_root', 'sb + "/missing"', '"unix:///var/run/docker.sock"', '"crm"', '["net_a"]'],
    ['symlink expected_root', 'sym_root', '"unix:///var/run/docker.sock"', '"crm"', '["net_a"]'],
    ['unsupported remote endpoint', 'sb', '"tcp://127.0.0.1:2375"', '"crm"', '["net_a"]'],
    ['empty expected_project', 'sb', '"unix:///var/run/docker.sock"', '""', '["net_a"]'],
    ['string expected_networks', 'sb', '"unix:///var/run/docker.sock"', '"crm"', '"net_a"'],
    ['dict expected_networks', 'sb', '"unix:///var/run/docker.sock"', '"crm"', '{"net_a": {}}'],
    ['empty expected_networks', 'sb', '"unix:///var/run/docker.sock"', '"crm"', '[]'],
    ['duplicate expected_networks', 'sb', '"unix:///var/run/docker.sock"', '"crm"', '["net_a", "net_a"]'],
    ['boolean in expected_networks', 'sb', '"unix:///var/run/docker.sock"', '"crm"', '[True]'],
  ])('rejects invalid caller context: %s', (_, rootExpr, endpExpr, projExpr, netsExpr) => {
    const sb = getSandbox()
    const symTarget = join(sb, 'sym')
    symlinkSync(sb, symTarget)
    expectPython(`${FIXTURE}
sb = "${sb}"
sym_root = "${symTarget}"
bdir, res = make_bundle(sb)
state = make_state(sb, bdir, res)
try:
    ws.validate_v2_bundle_state(state, expected_root=${rootExpr}, expected_endpoint=${endpExpr}, expected_project=${projExpr}, expected_networks=${netsExpr})
    print("FAILED")
except ValueError:
    print("REJECTED_CONTEXT")`, 'REJECTED_CONTEXT')
  })

  it.each([
    ['multiline string', '\'[\\n"net_a"\\n]\''],
    ['syntax error', '\'["net_a"\''],
    ['non-array object', '\'{"net_a": true}\''],
    ['non-array number', '\'123\''],
    ['wrapper key injection', '\'["net_a"], "extra": 1\''],
    ['number in array', '\'[123]\''],
    ['boolean in array', '\'[true]\''],
    ['null in array', '\'[null]\''],
    ['empty string in array', '\'[""]\''],
    ['whitespace in array', '\'["  "]\''],
    ['duplicate elements in array', '\'["net_a", "net_a"]\''],
    ['networks mismatch', '\'["other_net"]\''],
  ])('rejects malformed EXPECTED_NETWORKS json: %s', (_, jsonExpr) => {
    const sb = getSandbox()
    expectPython(`${FIXTURE}
sb = "${sb}"
bdir, res = make_bundle(sb)
state = make_state(sb, bdir, res, net_json=${jsonExpr})
try:
    ws.validate_v2_bundle_state(state, expected_root=sb, expected_endpoint="unix:///var/run/docker.sock", expected_project="crm", expected_networks=["net_a"])
    print("FAILED")
except ValueError:
    print("REJECTED_NET_JSON")`, 'REJECTED_NET_JSON')
  })

  it('rejects tampered manifest or payload when state bindings are valid', () => {
    const sb = getSandbox()
    expectPython(`${FIXTURE}
bdir, res = make_bundle("${sb}")
state = make_state("${sb}", bdir, res)
with open(os.path.join(bdir, "manifest.json"), "wb") as f:
    f.write(b"{}")
try:
    ws.validate_v2_bundle_state(state, expected_root="${sb}", expected_endpoint="unix:///var/run/docker.sock", expected_project="crm", expected_networks=["net_a"])
    print("FAILED")
except ValueError:
    print("TAMPER_REJECTED")`, 'TAMPER_REJECTED')
  })
})
