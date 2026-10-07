import { describe, expect, it, afterEach } from 'vitest'
import { join } from 'node:path'
import { statSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { createPrivateSandbox, type PrivateSandbox } from '../helpers/web-private-sandbox'
import { createBundleFixture, type BundleStateFixture } from '../helpers/web-bundle-fixture'

let sb: PrivateSandbox | null = null

afterEach(() => {
  if (sb) {
    sb.cleanup()
    sb = null
  }
})

function setupDeploy(sandbox: PrivateSandbox) {
  const deployDir = sandbox.mkdir('deploy', 0o700)
  const fixture = createBundleFixture(sandbox)
  return { deployDir, fixture }
}

function diag(res: { status: number | null; stdout?: string; stderr?: string; error?: Error }): string {
  const err = (res.stderr || '').trim().slice(0, 400)
  const out = (res.stdout || '').trim().slice(0, 200)
  const msg = res.error ? ` err=${res.error.message}` : ''
  return `status=${res.status}${msg} stderr=${err || '<empty>'} stdout=${out || '<empty>'}`
}

function buildValidCliArgs(deployDir: string, fixture: BundleStateFixture): string[] {
  return [
    '--state-root', deployDir,
    '--bundle-dir', fixture.bundleDir,
    '--manifest-sha256', fixture.manifestSha256,
    '--previous-id', fixture.state.PREVIOUS_ID,
    '--deployed-id', fixture.state.DEPLOYED_ID,
    '--expected-root', fixture.expectedArgs.expected_root,
    '--expected-endpoint', fixture.expectedArgs.expected_endpoint,
    '--expected-project', fixture.expectedArgs.expected_project,
    '--expected-networks', JSON.stringify(fixture.expectedArgs.expected_networks),
  ]
}

function buildBadShaArgs(deployDir: string, fixture: BundleStateFixture): string[] {
  const args = buildValidCliArgs(deployDir, fixture)
  const idx = args.indexOf('--manifest-sha256')
  args[idx + 1] = '0'.repeat(64)
  return args
}

const FAULT_HARNESS_PY = `import sys, json, io, os
import scripts.web_only_state_publisher as wsp

cfg = json.loads(sys.argv[1])
cli_args = cfg["cli_args"]
fail_at = cfg["fail_at"]
mock_fsync = cfg.get("mock_fsync", False)
spy_publish = cfg.get("spy_publish", False)

class FailingStdout(io.StringIO):
    def __init__(self, mode):
        super().__init__()
        self.mode = mode
        self.write_calls = 0
        self.flush_calls = 0

    def write(self, s):
        self.write_calls += 1
        if self.mode == "write":
            raise OSError("simulated broken pipe on write")
        return super().write(s)

    def flush(self):
        self.flush_calls += 1
        if self.mode == "flush":
            raise OSError("simulated broken pipe on flush")
        return super().flush()

fake_stdout = FailingStdout(fail_at)
real_stdout = sys.stdout

rf, sc = os.fsync, [0]
if mock_fsync:
    def fake_fsync(fd):
        sc[0] += 1
        if sc[0] == 2:
            raise OSError("simulated fsync error")
        return rf(fd)
    os.fsync = fake_fsync

orig_pub = wsp.publish_v2_release_state
spy_calls = [0]
if spy_publish:
    def spy_pub(*a, **k):
        spy_calls[0] += 1
        return orig_pub(*a, **k)
    wsp.publish_v2_release_state = spy_pub

sys.stdout = fake_stdout
try:
    code = wsp.main(cli_args)
finally:
    sys.stdout = real_stdout
    if mock_fsync:
        os.fsync = rf
    if spy_publish:
        wsp.publish_v2_release_state = orig_pub

if fail_at == "write":
    assert fake_stdout.write_calls == 1, f"expected 1 write call, got {fake_stdout.write_calls}"
    assert fake_stdout.flush_calls == 0, f"expected 0 flush calls, got {fake_stdout.flush_calls}"
elif fail_at == "flush":
    assert fake_stdout.write_calls == 1, f"expected 1 write call, got {fake_stdout.write_calls}"
    assert fake_stdout.flush_calls == 1, f"expected 1 flush call, got {fake_stdout.flush_calls}"

if spy_publish:
    assert spy_calls[0] == 0, f"expected 0 publish calls, got {spy_calls[0]}"
if mock_fsync:
    assert sc[0] == 2, f"expected 2 fsync calls, got {sc[0]}"

sys.exit(code)`

function runFaultCli(
  sandbox: PrivateSandbox,
  cliArgs: string[],
  failAt: 'write' | 'flush',
  options: { mockFsync?: boolean; spyPublish?: boolean } = {}
) {
  const cfg = {
    cli_args: cliArgs,
    fail_at: failAt,
    mock_fsync: options.mockFsync ?? false,
    spy_publish: options.spyPublish ?? false,
  }
  return sandbox.runPython(FAULT_HARNESS_PY, { args: [JSON.stringify(cfg)] })
}

describe('web-only-state-publisher CLI stdout transport fault injection', () => {
  it('handles stdout write failure on publication success: exit 4, ERR_TRANSPORT_STDOUT, proper 0600 file', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const validArgs = buildValidCliArgs(deployDir, fixture)
    const res = runFaultCli(sb, validArgs, 'write')
    expect(res.status, diag(res)).toBe(4)
    expect(res.stderr).toBe('ERR_TRANSPORT_STDOUT\n')
    expect(res.stderr.trim()).toBe('ERR_TRANSPORT_STDOUT')
    expect(res.stderr).toContain('ERR_TRANSPORT_STDOUT')
    expect(res.stderr).not.toContain('ERR_PRECOMMIT_FAILED')
    const targetFile = join(deployDir, 'release.env')
    expect(existsSync(targetFile)).toBe(true)
    expect(statSync(targetFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(targetFile, 'utf8')).toBe(fixture.serializedState)
    expect(readdirSync(deployDir)).toEqual(['release.env'])
  })

  it('catches stdout flush failure on publication success: exit 4, ERR_TRANSPORT_STDOUT, and no false precommit', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const validArgs = buildValidCliArgs(deployDir, fixture)
    const resSuccess = runFaultCli(sb, validArgs, 'flush')
    expect(resSuccess.status, diag(resSuccess)).toBe(4)
    expect(resSuccess.status).toBe(4)
    expect(resSuccess.stderr).toBe('ERR_TRANSPORT_STDOUT\n')
    expect(resSuccess.stderr).toContain('ERR_TRANSPORT_STDOUT')
    expect(resSuccess.stderr).not.toContain('ERR_PRECOMMIT_FAILED')
    expect(existsSync(join(deployDir, 'release.env'))).toBe(true)
    const targetFile = join(deployDir, 'release.env')
    expect(statSync(targetFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(targetFile, 'utf8')).toBe(fixture.serializedState)
    expect(readdirSync(deployDir)).toEqual(['release.env'])
  })

  it('preserves WARN_POST_COMMIT_SYNC on stdout write failure during postcommit sync failure', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const validArgs = buildValidCliArgs(deployDir, fixture)
    const resWarn = runFaultCli(sb, validArgs, 'write', { mockFsync: true })
    expect(resWarn.status, diag(resWarn)).toBe(4)
    expect(resWarn.status).toBe(4)
    expect(resWarn.stderr).toBe('WARN_POST_COMMIT_SYNC\nERR_TRANSPORT_STDOUT\n')
    expect(resWarn.stderr).toContain('WARN_POST_COMMIT_SYNC')
    expect(resWarn.stderr).toContain('ERR_TRANSPORT_STDOUT')
    expect(resWarn.stderr.indexOf('WARN_POST_COMMIT_SYNC')).toBeLessThan(resWarn.stderr.indexOf('ERR_TRANSPORT_STDOUT'))
    expect(resWarn.stderr).not.toContain('ERR_PRECOMMIT_FAILED')
    const targetFile = join(deployDir, 'release.env')
    expect(existsSync(targetFile)).toBe(true)
    expect(statSync(targetFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(targetFile, 'utf8')).toBe(fixture.serializedState)
    expect(readdirSync(deployDir)).toEqual(['release.env'])
  })

  it('preserves WARN_POST_COMMIT_SYNC on stdout flush failure during postcommit sync failure', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const validArgs = buildValidCliArgs(deployDir, fixture)
    const res = runFaultCli(sb, validArgs, 'flush', { mockFsync: true })
    expect(res.status, diag(res)).toBe(4)
    expect(res.stderr).toBe('WARN_POST_COMMIT_SYNC\nERR_TRANSPORT_STDOUT\n')
    expect(res.stderr).toContain('WARN_POST_COMMIT_SYNC')
    expect(res.stderr).toContain('ERR_TRANSPORT_STDOUT')
    expect(res.stderr.indexOf('WARN_POST_COMMIT_SYNC')).toBeLessThan(res.stderr.indexOf('ERR_TRANSPORT_STDOUT'))
    expect(res.stderr).not.toContain('ERR_PRECOMMIT_FAILED')
    const targetFile = join(deployDir, 'release.env')
    expect(existsSync(targetFile)).toBe(true)
    expect(statSync(targetFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(targetFile, 'utf8')).toBe(fixture.serializedState)
    expect(readdirSync(deployDir)).toEqual(['release.env'])
  })

  it('preserves ERR_INVALID_ARGS on stdout write failure with zero publication spy hits and empty dir', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const invalidArgs = ['--bundle-dir', fixture.bundleDir]
    const res = runFaultCli(sb, invalidArgs, 'write', { spyPublish: true })
    expect(res.status, diag(res)).toBe(4)
    expect(res.stderr).toBe('ERR_INVALID_ARGS\nERR_TRANSPORT_STDOUT\n')
    expect(res.stderr).toContain('ERR_INVALID_ARGS')
    expect(res.stderr).toContain('ERR_TRANSPORT_STDOUT')
    expect(res.stderr.indexOf('ERR_INVALID_ARGS')).toBeLessThan(res.stderr.indexOf('ERR_TRANSPORT_STDOUT'))
    expect(res.stderr).not.toContain('ERR_PRECOMMIT_FAILED')
    expect(readdirSync(deployDir).length).toBe(0)
    expect(readdirSync(deployDir)).toEqual([])
    expect(existsSync(join(deployDir, 'release.env'))).toBe(false)
  })

  it('preserves ERR_INVALID_ARGS on stdout flush failure with zero publication spy hits and empty dir', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const invalidArgs = ['--bundle-dir', fixture.bundleDir]
    const res = runFaultCli(sb, invalidArgs, 'flush', { spyPublish: true })
    expect(res.status, diag(res)).toBe(4)
    expect(res.stderr).toBe('ERR_INVALID_ARGS\nERR_TRANSPORT_STDOUT\n')
    expect(res.stderr).toContain('ERR_INVALID_ARGS')
    expect(res.stderr).toContain('ERR_TRANSPORT_STDOUT')
    expect(res.stderr.indexOf('ERR_INVALID_ARGS')).toBeLessThan(res.stderr.indexOf('ERR_TRANSPORT_STDOUT'))
    expect(res.stderr).not.toContain('ERR_PRECOMMIT_FAILED')
    expect(readdirSync(deployDir).length).toBe(0)
    expect(readdirSync(deployDir)).toEqual([])
    expect(existsSync(join(deployDir, 'release.env'))).toBe(false)
  })

  it('preserves ERR_PRECOMMIT_FAILED on stdout write failure with seeded 0644 target preserved and no temp', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const existingFile = join(deployDir, 'release.env')
    writeFileSync(existingFile, 'OLD_TARGET_DATA\n', { mode: 0o644 })
    const origStat = statSync(existingFile)
    const badShaArgs = buildBadShaArgs(deployDir, fixture)
    const res = runFaultCli(sb, badShaArgs, 'write')
    expect(res.status, diag(res)).toBe(4)
    expect(res.stderr).toBe('ERR_PRECOMMIT_FAILED\nERR_TRANSPORT_STDOUT\n')
    expect(res.stderr).toContain('ERR_PRECOMMIT_FAILED')
    expect(res.stderr).toContain('ERR_TRANSPORT_STDOUT')
    expect(res.stderr.indexOf('ERR_PRECOMMIT_FAILED')).toBeLessThan(res.stderr.indexOf('ERR_TRANSPORT_STDOUT'))
    expect(readFileSync(existingFile, 'utf8')).toBe('OLD_TARGET_DATA\n')
    expect(statSync(existingFile).mtimeMs).toBe(origStat.mtimeMs)
    expect(statSync(existingFile).mode & 0o777).toBe(0o644)
    expect(readdirSync(deployDir).filter((f) => f.includes('tmp')).length).toBe(0)
    expect(readdirSync(deployDir)).toEqual(['release.env'])
  })

  it('preserves ERR_PRECOMMIT_FAILED on stdout flush failure with seeded 0644 target preserved and no temp', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const existingFile = join(deployDir, 'release.env')
    writeFileSync(existingFile, 'OLD_TARGET_DATA\n', { mode: 0o644 })
    const origStat = statSync(existingFile)
    const badShaArgs = buildBadShaArgs(deployDir, fixture)
    const res = runFaultCli(sb, badShaArgs, 'flush')
    expect(res.status, diag(res)).toBe(4)
    expect(res.stderr).toBe('ERR_PRECOMMIT_FAILED\nERR_TRANSPORT_STDOUT\n')
    expect(res.stderr).toContain('ERR_PRECOMMIT_FAILED')
    expect(res.stderr).toContain('ERR_TRANSPORT_STDOUT')
    expect(res.stderr.indexOf('ERR_PRECOMMIT_FAILED')).toBeLessThan(res.stderr.indexOf('ERR_TRANSPORT_STDOUT'))
    expect(readFileSync(existingFile, 'utf8')).toBe('OLD_TARGET_DATA\n')
    expect(statSync(existingFile).mtimeMs).toBe(origStat.mtimeMs)
    expect(statSync(existingFile).mode & 0o777).toBe(0o644)
    expect(readdirSync(deployDir).filter((f) => f.includes('tmp')).length).toBe(0)
    expect(readdirSync(deployDir)).toEqual(['release.env'])
  })
})
