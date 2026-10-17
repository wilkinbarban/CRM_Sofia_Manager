import { describe, expect, it, afterEach } from 'vitest'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createPrivateSandbox, PYTHON_BIN, PrivateSandbox } from '../helpers/web-private-sandbox'

const SCRIPT_PATH = join(process.cwd(), 'scripts/web_only_bundle_lifecycle.py')

let sb: PrivateSandbox | null = null

afterEach(() => {
  sb?.cleanup()
  sb = null
})

function runCli(args: string[]) {
  return spawnSync(PYTHON_BIN, ['-B', SCRIPT_PATH, ...args], {
    env: { NODE_ENV: 'test',
      PATH: '/usr/bin:/bin',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: join(process.cwd(), 'scripts') + ':' + process.cwd(),
    },
    encoding: 'utf8',
  })
}

function makeBundle(sandbox: PrivateSandbox, bdir: string) {
  const code = `
import json, scripts.web_only_bundle_writer as bw
cand = {
  "services": {"web": {"image": "sha256:${'c'.repeat(64)}", "ports": [{"published": 3020, "target": 3000, "host_ip": "127.0.0.1", "protocol": "tcp"}], "networks": {"sofia_net": {"aliases": ["web"]}}}},
  "networks": {"sofia_net": {"name": "sofia_net", "external": True}}
}
roll = {
  "services": {"web": {"image": "sha256:${'d'.repeat(64)}", "ports": [{"published": 3020, "target": 3000, "host_ip": "127.0.0.1", "protocol": "tcp"}], "networks": {"sofia_net": {"aliases": ["web"]}}}},
  "networks": {"sofia_net": {"name": "sofia_net", "external": True}}
}
meta = {
  "project": "sofia", "service": "web", "candidate_image_id": "sha256:${'c'.repeat(64)}", "current_image_id": "sha256:${'d'.repeat(64)}",
  "container_id": "${'e'.repeat(64)}", "container_name": "sofia-web",
  "ports": {"published": 3020, "target": 3000, "host_ip": "127.0.0.1", "protocol": "tcp"},
  "networks": ["sofia_net"]
}
bw.write_effective_bundle("${bdir}", json.dumps(cand).encode(), json.dumps(roll).encode(), manifest_metadata=meta)
`
  const ret = sandbox.runPython(code)
  if (ret.status !== 0) throw new Error(`Bundle creation failed: ${ret.stderr}`)
}

function writeState(stateRoot: string, bundleDir: string) {
  const lines = [
    'STATE_VERSION=2',
    'DEPLOY_MODE=web-only',
    `BUNDLE_DIR=${bundleDir}`,
    `MANIFEST_SHA256=${'a'.repeat(64)}`,
    'COMPOSE_PROJECT=sofia',
    'OPERATIONAL_ROOT=/var/lib/asados/deploy-root',
    'DOCKER_ENDPOINT=unix:///var/run/docker.sock',
    'EXPECTED_NETWORKS=sofia_net',
    `PREVIOUS_ID=sha256:${'1'.repeat(64)}`,
    `DEPLOYED_ID=sha256:${'2'.repeat(64)}`,
  ]
  writeFileSync(join(stateRoot, 'release.env'), lines.join('\n') + '\n', { mode: 0o600 })
}

function bundlePath(stateRoot: string, token: string) {
  return join(stateRoot, `bundle-${token.repeat(32)}`)
}

describe('web-only-bundle-prune superseded bundle retirement', () => {
  it('removes a superseded bundle and keeps the active bundle named by release.env', () => {
    sb = createPrivateSandbox()
    const stateRoot = sb.mkdir('state-root')
    const active = bundlePath(stateRoot, 'a')
    const stale = bundlePath(stateRoot, 'b')
    makeBundle(sb, active)
    makeBundle(sb, stale)
    writeState(stateRoot, active)

    const ret = runCli(['prune', '--state-root', stateRoot])

    expect(ret.status).toBe(0)
    expect(existsSync(active)).toBe(true)
    expect(existsSync(stale)).toBe(false)
  })

  it('keeps an explicitly protected bundle even when it is not the active one', () => {
    sb = createPrivateSandbox()
    const stateRoot = sb.mkdir('state-root')
    const active = bundlePath(stateRoot, 'a')
    const kept = bundlePath(stateRoot, 'c')
    const stale = bundlePath(stateRoot, 'b')
    makeBundle(sb, active)
    makeBundle(sb, kept)
    makeBundle(sb, stale)
    writeState(stateRoot, active)

    const ret = runCli(['prune', '--state-root', stateRoot, '--keep', kept])

    expect(ret.status).toBe(0)
    expect(existsSync(active)).toBe(true)
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(stale)).toBe(false)
  })

  it('fails closed and removes nothing when release.env is missing', () => {
    sb = createPrivateSandbox()
    const stateRoot = sb.mkdir('state-root')
    const stale = bundlePath(stateRoot, 'b')
    makeBundle(sb, stale)

    const ret = runCli(['prune', '--state-root', stateRoot])

    expect(ret.status).toBe(2)
    expect(ret.stderr.trim().length).toBeGreaterThan(0)
    expect(existsSync(stale)).toBe(true)
  })

  it('fails closed and removes nothing when release.env is malformed', () => {
    sb = createPrivateSandbox()
    const stateRoot = sb.mkdir('state-root')
    const stale = bundlePath(stateRoot, 'b')
    makeBundle(sb, stale)
    writeFileSync(join(stateRoot, 'release.env'), 'STATE_VERSION=2\nBUNDLE_DIR\n', { mode: 0o600 })

    const ret = runCli(['prune', '--state-root', stateRoot])

    expect(ret.status).toBe(2)
    expect(existsSync(stale)).toBe(true)
  })

  it('fails closed and removes nothing when BUNDLE_DIR points outside the state root', () => {
    sb = createPrivateSandbox()
    const stateRoot = sb.mkdir('state-root')
    const outside = sb.mkdir('outside')
    const stale = bundlePath(stateRoot, 'b')
    makeBundle(sb, stale)
    writeState(stateRoot, bundlePath(outside, 'a'))

    const ret = runCli(['prune', '--state-root', stateRoot])

    expect(ret.status).toBe(2)
    expect(existsSync(stale)).toBe(true)
  })

  it('reports candidates without removing anything under --dry-run', () => {
    sb = createPrivateSandbox()
    const stateRoot = sb.mkdir('state-root')
    const active = bundlePath(stateRoot, 'a')
    const stale = bundlePath(stateRoot, 'b')
    makeBundle(sb, active)
    makeBundle(sb, stale)
    writeState(stateRoot, active)

    const ret = runCli(['prune', '--state-root', stateRoot, '--dry-run'])

    expect(ret.status).toBe(0)
    expect(ret.stdout).toContain(stale)
    expect(existsSync(stale)).toBe(true)
    expect(existsSync(active)).toBe(true)
  })

  it('fails closed instead of silently ignoring a relative --keep path', () => {
    sb = createPrivateSandbox()
    const stateRoot = sb.mkdir('state-root')
    const active = bundlePath(stateRoot, 'a')
    const stale = bundlePath(stateRoot, 'b')
    makeBundle(sb, active)
    makeBundle(sb, stale)
    writeState(stateRoot, active)

    const ret = runCli(['prune', '--state-root', stateRoot, '--keep', 'bundle-relative'])

    expect(ret.status).toBe(2)
    expect(ret.stderr.trim().length).toBeGreaterThan(0)
    expect(existsSync(stale)).toBe(true)
    expect(existsSync(active)).toBe(true)
  })

  it('preserves and reports a bundle directory holding an unknown extra entry', () => {
    sb = createPrivateSandbox()
    const stateRoot = sb.mkdir('state-root')
    const active = bundlePath(stateRoot, 'a')
    const hostile = bundlePath(stateRoot, 'b')
    makeBundle(sb, active)
    makeBundle(sb, hostile)
    writeFileSync(join(hostile, 'foreign.txt'), 'keep me\n', { mode: 0o600 })
    writeState(stateRoot, active)

    const ret = runCli(['prune', '--state-root', stateRoot])

    expect(existsSync(hostile)).toBe(true)
    expect(ret.stdout).toContain(hostile)
    expect(ret.status).toBe(2)
  })

  it('never touches an entry that is not a bundle directory', () => {
    sb = createPrivateSandbox()
    const stateRoot = sb.mkdir('state-root')
    const active = bundlePath(stateRoot, 'a')
    makeBundle(sb, active)
    writeState(stateRoot, active)
    writeFileSync(join(stateRoot, 'release.env.backup'), 'not a bundle\n', { mode: 0o600 })

    const ret = runCli(['prune', '--state-root', stateRoot])

    expect(ret.status).toBe(0)
    expect(existsSync(join(stateRoot, 'release.env.backup'))).toBe(true)
    expect(existsSync(active)).toBe(true)
  })
})
