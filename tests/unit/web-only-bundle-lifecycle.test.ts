import { describe, expect, it, afterEach } from 'vitest'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync, symlinkSync, lstatSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createPrivateSandbox, PYTHON_BIN, PrivateSandbox } from '../helpers/web-private-sandbox'

const SCRIPT_PATH = join(process.cwd(), 'scripts/web_only_bundle_lifecycle.py')

let sb: PrivateSandbox | null = null

afterEach(() => {
  sb?.cleanup()
  sb = null
})

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(PYTHON_BIN, ['-B', SCRIPT_PATH, ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: join(process.cwd(), 'scripts') + ':' + process.cwd(),
      ...env,
    },
    encoding: 'utf8',
  })
}

function createRealBundle(sandbox: PrivateSandbox, bdir: string, candId: string, currId: string, cid: string) {
  const code = `
import json, scripts.web_only_bundle_writer as bw
cand = {
  "services": {"web": {"image": "${candId}", "ports": [{"published": 3020, "target": 3000, "host_ip": "127.0.0.1", "protocol": "tcp"}], "networks": {"sofia_net": {"aliases": ["web"]}}}},
  "networks": {"sofia_net": {"name": "sofia_net", "external": True}}
}
roll = {
  "services": {"web": {"image": "${currId}", "ports": [{"published": 3020, "target": 3000, "host_ip": "127.0.0.1", "protocol": "tcp"}], "networks": {"sofia_net": {"aliases": ["web"]}}}},
  "networks": {"sofia_net": {"name": "sofia_net", "external": True}}
}
meta = {
  "project": "sofia", "service": "web", "candidate_image_id": "${candId}", "current_image_id": "${currId}",
  "container_id": "${cid}", "container_name": "sofia-web",
  "ports": {"published": 3020, "target": 3000, "host_ip": "127.0.0.1", "protocol": "tcp"},
  "networks": ["sofia_net"]
}
bw.write_effective_bundle("${bdir}", json.dumps(cand).encode(), json.dumps(roll).encode(), manifest_metadata=meta)
`
  const ret = sandbox.runPython(code)
  if (ret.status !== 0) throw new Error(`Bundle creation failed: ${ret.stderr}`)
}

describe('web-only-bundle-lifecycle Unit tests', () => {
  it('allocates canonical path and refuses clobber on collision', () => {
    sb = createPrivateSandbox()
    const stateRoot = sb.mkdir('state-root')

    const ret = runCli(['allocate', '--state-root', stateRoot])
    expect(ret.status).toBe(0)
    const allocated = ret.stdout.trim()
    expect(allocated).toMatch(new RegExp(`^${stateRoot}/bundle-[0-9a-fA-F]{32}$`))
    expect(existsSync(allocated)).toBe(false)

    sb.mkdir('state-root/bundle-forced123')
    const colRet = runCli(['allocate', '--state-root', stateRoot], { _TEST_FORCE_BUNDLE_TOKEN: 'forced123' })
    expect(colRet.status).toBe(2)
    expect(colRet.stderr.length).toBeGreaterThan(0)
  })

  it('cleanup removes directory and known entries on success', () => {
    sb = createPrivateSandbox()
    const bdir = sb.mkdir('bundle-clean')
    writeFileSync(join(bdir, 'manifest.json'), '{}')
    writeFileSync(join(bdir, 'candidate-compose.json'), '{}')
    writeFileSync(join(bdir, 'rollback-compose.json'), '{}')

    const ret = runCli(['cleanup', '--bundle-dir', bdir])
    expect(ret.status).toBe(0)
    expect(existsSync(bdir)).toBe(false)
  })

  it('cleanup removes an in-flight .manifest.json.tmp leftover', () => {
    sb = createPrivateSandbox()
    const bdir = sb.mkdir('bundle-tmp')
    writeFileSync(join(bdir, '.manifest.json.tmp'), '{}')
    writeFileSync(join(bdir, 'candidate-compose.json'), '{}')

    const ret = runCli(['cleanup', '--bundle-dir', bdir])
    expect(ret.status).toBe(0)
    expect(existsSync(bdir)).toBe(false)
  })

  it('cleanup PRESERVES unknown extra entries with exit2 and non-empty honest stderr', () => {
    sb = createPrivateSandbox()
    const bdir = sb.mkdir('bundle-unknown')
    writeFileSync(join(bdir, 'manifest.json'), '{}')
    const foreign = join(bdir, 'unknown.txt')
    writeFileSync(foreign, 'foreign')

    const ret = runCli(['cleanup', '--bundle-dir', bdir])
    expect(ret.status).toBe(2)
    expect(ret.stderr.trim().length).toBeGreaterThan(0)
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(bdir)).toBe(true)
  })

  it('cleanup preserves symlink-swapped known entry with exit2', () => {
    sb = createPrivateSandbox()
    const bdir = sb.mkdir('bundle-sym')
    const linkPath = join(bdir, 'manifest.json')
    symlinkSync('/dev/null', linkPath)

    const ret = runCli(['cleanup', '--bundle-dir', bdir])
    expect(ret.status).toBe(2)
    expect(existsSync(bdir)).toBe(true)
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
  })

  it('cleanup succeeds idempotently on repeat and never-allocated targets', () => {
    sb = createPrivateSandbox()
    const bdir = sb.mkdir('bundle-idem')
    expect(runCli(['cleanup', '--bundle-dir', bdir]).status).toBe(0)
    const repeat = runCli(['cleanup', '--bundle-dir', bdir])
    expect(repeat.status).toBe(0)
    expect(repeat.stderr).toBe('')
    const never = runCli(['cleanup', '--bundle-dir', join(sb.dir, 'missing-root/bundle-never')])
    expect(never.status).toBe(0)
    expect(never.stderr).toBe('')
  })

  it('validate succeeds with exit0 against real bundle produced by existing writer', () => {
    sb = createPrivateSandbox()
    const bdir = join(sb.dir, 'real-bundle')
    const candId = 'sha256:' + 'a'.repeat(64)
    const currId = 'sha256:' + 'b'.repeat(64)
    const cid = 'c'.repeat(64)
    createRealBundle(sb, bdir, candId, currId, cid)

    const mSha = createHash('sha256').update(readFileSync(join(bdir, 'manifest.json'))).digest('hex')
    const ret = runCli([
      'validate', '--bundle-dir', bdir, '--manifest-sha', mSha, '--project', 'sofia',
      '--candidate-image-id', candId, '--current-image-id', currId,
      '--container-id', cid, '--networks', 'sofia_net',
    ])
    expect(ret.status).toBe(0)
  })

  it('validate rejects project/candidate/current-image mismatch with exit2 and non-empty stderr reason', () => {
    sb = createPrivateSandbox()
    const bdir = join(sb.dir, 'real-bundle')
    const candId = 'sha256:' + 'a'.repeat(64)
    const currId = 'sha256:' + 'b'.repeat(64)
    const cid = 'c'.repeat(64)
    createRealBundle(sb, bdir, candId, currId, cid)

    const mSha = createHash('sha256').update(readFileSync(join(bdir, 'manifest.json'))).digest('hex')
    const ret = runCli([
      'validate', '--bundle-dir', bdir, '--manifest-sha', mSha, '--project', 'wrongproject',
      '--candidate-image-id', candId, '--current-image-id', currId,
      '--container-id', cid, '--networks', 'sofia_net',
    ])
    expect(ret.status).toBe(2)
    expect(ret.stderr.trim().length).toBeGreaterThan(0)
  })

  it('validate rejects container_id mismatch with exit2', () => {
    sb = createPrivateSandbox()
    const bdir = join(sb.dir, 'real-bundle')
    const candId = 'sha256:' + 'a'.repeat(64)
    const currId = 'sha256:' + 'b'.repeat(64)
    const cid = 'c'.repeat(64)
    createRealBundle(sb, bdir, candId, currId, cid)

    const mSha = createHash('sha256').update(readFileSync(join(bdir, 'manifest.json'))).digest('hex')
    const ret = runCli([
      'validate', '--bundle-dir', bdir, '--manifest-sha', mSha, '--project', 'sofia',
      '--candidate-image-id', candId, '--current-image-id', currId,
      '--container-id', 'd'.repeat(64), '--networks', 'sofia_net',
    ])
    expect(ret.status).toBe(2)
  })
})
