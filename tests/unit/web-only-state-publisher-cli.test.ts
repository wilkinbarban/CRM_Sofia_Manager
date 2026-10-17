import { describe, expect, it, afterEach } from 'vitest'
import { join } from 'node:path'
import { statSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

const PYTHON_BIN = 'python3'

function runPublisherCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(PYTHON_BIN, ['-B', 'scripts/web_only_state_publisher.py', ...args], {
    env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '.', ...env },
    timeout: 20000,
    encoding: 'utf8',
  })
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

describe('web-only-state-publisher CLI transport', () => {
  it('executes valid publication, emits durable JSON record, and verifies root state integrity', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const validArgs = buildValidCliArgs(deployDir, fixture)
    const res = runPublisherCli(validArgs)
    expect(res.status, diag(res)).toBe(0)
    expect(res.stderr).toBe('')
    const out = JSON.parse(res.stdout.trim())
    expect(out).toEqual({
      status: 'ok',
      state_file: join(deployDir, 'release.env'),
      committed: true,
      durable: true,
    })
    const targetFile = join(deployDir, 'release.env')
    expect(existsSync(targetFile)).toBe(true)
    expect(statSync(targetFile).mode & 0o777).toBe(0o600)
  })

  it('rejects invalid args, duplicate flags, abbreviations, and suppresses secret leakage', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const res1 = runPublisherCli(['--bundle-dir', fixture.bundleDir])
    expect(res1.status, diag(res1)).toBe(2)
    expect(res1.stderr.trim()).toBe('ERR_INVALID_ARGS')
    expect(JSON.parse(res1.stdout.trim())).toEqual({
      status: 'error',
      committed: false,
      durable: false,
      error: 'ERR_INVALID_ARGS',
    })
    expect(readdirSync(deployDir).length).toBe(0)

    const validArgs = buildValidCliArgs(deployDir, fixture)
    const secretValue = 'super_secret_diagnostic_token_12345'
    const res2 = runPublisherCli([...validArgs, '--bad-secret-flag', secretValue])
    expect(res2.status, diag(res2)).toBe(2)
    expect(res2.stderr.trim()).toBe('ERR_INVALID_ARGS')
    expect(res2.stderr).not.toContain(secretValue)
    expect(res2.stderr).not.toContain('Traceback')
    expect(res2.stderr).not.toContain(deployDir)

    // Strict allow_abbrev=False rejection
    const abbrevArgs = validArgs.map((a) => (a === '--state-root' ? '--state' : a))
    const resAbbrev = runPublisherCli(abbrevArgs)
    expect(resAbbrev.status, diag(resAbbrev)).toBe(2)
    expect(resAbbrev.stderr.trim()).toBe('ERR_INVALID_ARGS')

    // Duplicate flag rejection across --x v, --x=v, and mixed forms
    const dup1 = runPublisherCli([...validArgs, '--state-root', deployDir])
    expect(dup1.status, diag(dup1)).toBe(2)
    expect(dup1.stderr.trim()).toBe('ERR_INVALID_ARGS')

    const dup2 = runPublisherCli([...validArgs, `--state-root=${deployDir}`])
    expect(dup2.status, diag(dup2)).toBe(2)
    expect(dup2.stderr.trim()).toBe('ERR_INVALID_ARGS')

    const dup3 = runPublisherCli([`--state-root=${deployDir}`, ...validArgs])
    expect(dup3.status, diag(dup3)).toBe(2)
    expect(dup3.stderr.trim()).toBe('ERR_INVALID_ARGS')

    // Malformed JSON networks
    const res3 = runPublisherCli([
      '--state-root', deployDir,
      '--bundle-dir', fixture.bundleDir,
      '--manifest-sha256', fixture.manifestSha256,
      '--previous-id', fixture.state.PREVIOUS_ID,
      '--deployed-id', fixture.state.DEPLOYED_ID,
      '--expected-root', fixture.expectedArgs.expected_root,
      '--expected-endpoint', fixture.expectedArgs.expected_endpoint,
      '--expected-project', fixture.expectedArgs.expected_project,
      '--expected-networks', '["unclosed_networks',
    ])
    expect(res3.status, diag(res3)).toBe(2)
    expect(res3.stderr.trim()).toBe('ERR_INVALID_ARGS')
    expect(readdirSync(deployDir).length).toBe(0)
  })

  it('strictly verifies endpoints: neither defaults to unix socket and explicit mismatch fails closed before mutation', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const baseArgsWithoutEndpoint = [
      '--state-root', deployDir,
      '--bundle-dir', fixture.bundleDir,
      '--manifest-sha256', fixture.manifestSha256,
      '--previous-id', fixture.state.PREVIOUS_ID,
      '--deployed-id', fixture.state.DEPLOYED_ID,
      '--expected-root', fixture.expectedArgs.expected_root,
      '--expected-project', fixture.expectedArgs.expected_project,
      '--expected-networks', JSON.stringify(fixture.expectedArgs.expected_networks),
    ]

    // Missing endpoint completely (neither defaults to unix:///var/run/docker.sock)
    const resNoEndpoint = runPublisherCli(baseArgsWithoutEndpoint)
    expect(resNoEndpoint.status, diag(resNoEndpoint)).toBe(2)
    expect(resNoEndpoint.stderr.trim()).toBe('ERR_INVALID_ARGS')
    expect(readdirSync(deployDir).length).toBe(0)

    // Explicit mismatch between expected and actual docker endpoint fails closed with exit 2 before mutation
    const mismatchArgs = [
      ...baseArgsWithoutEndpoint,
      '--expected-endpoint', 'unix:///var/run/docker.sock',
      '--docker-endpoint', 'unix:///var/run/custom-docker.sock',
    ]
    const resMismatch = runPublisherCli(mismatchArgs)
    expect(resMismatch.status, diag(resMismatch)).toBe(2)
    expect(resMismatch.stderr.trim()).toBe('ERR_INVALID_ARGS')
    expect(readdirSync(deployDir).length).toBe(0)

    // Matching endpoints succeed with exit 0
    const matchingArgs = [
      ...baseArgsWithoutEndpoint,
      '--expected-endpoint', fixture.expectedArgs.expected_endpoint,
      '--docker-endpoint', fixture.expectedArgs.expected_endpoint,
    ]
    const resMatching = runPublisherCli(matchingArgs)
    expect(resMatching.status, diag(resMatching)).toBe(0)
    expect(existsSync(join(deployDir, 'release.env'))).toBe(true)
  })

  it('handles precommit validation failure with exit 1, committed=false, and preserves old target bytes and stat', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const existingFile = join(deployDir, 'release.env')
    writeFileSync(existingFile, 'OLD_TARGET_DATA\n', { mode: 0o644 })
    const origStat = statSync(existingFile)

    const badShaArgs = [
      '--state-root', deployDir,
      '--bundle-dir', fixture.bundleDir,
      '--manifest-sha256', '0'.repeat(64),
      '--previous-id', fixture.state.PREVIOUS_ID,
      '--deployed-id', fixture.state.DEPLOYED_ID,
      '--expected-root', fixture.expectedArgs.expected_root,
      '--expected-endpoint', fixture.expectedArgs.expected_endpoint,
      '--expected-project', fixture.expectedArgs.expected_project,
      '--expected-networks', JSON.stringify(fixture.expectedArgs.expected_networks),
    ]
    const res = runPublisherCli(badShaArgs)
    expect(res.status, diag(res)).toBe(1)
    expect(res.stderr.trim()).toBe('ERR_PRECOMMIT_FAILED')
    const out = JSON.parse(res.stdout.trim())
    expect(out).toEqual({
      status: 'error',
      state_file: existingFile,
      committed: false,
      durable: false,
      error: 'ERR_PRECOMMIT_FAILED',
    })
    expect(readFileSync(existingFile, 'utf8')).toBe('OLD_TARGET_DATA\n')
    expect(statSync(existingFile).mtimeMs).toBe(origStat.mtimeMs)
    expect(statSync(existingFile).mode & 0o777).toBe(0o644)
    expect(readdirSync(deployDir).filter((f) => f.includes('tmp')).length).toBe(0)
  })

  it('reports exit 3 warning with committed=true and visible published state on postcommit sync failure', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const validArgs = buildValidCliArgs(deployDir, fixture)
    const harnessPy = `import sys, json, os
import scripts.web_only_state_publisher as wsp
assert callable(getattr(wsp, "main", None)), "scripts.web_only_state_publisher.main entrypoint is missing (postcommit sync CLI requires main)"
data = json.loads(sys.argv[1])
cli_args = data["cli_args"]
rf, sc = os.fsync, [0]
def mock_fsync(fd):
    sc[0] += 1
    if sc[0] == 2:
        raise OSError("simulated postcommit directory fsync error")
    return rf(fd)
os.fsync = mock_fsync
try:
    code = wsp.main(cli_args)
finally:
    os.fsync = rf
sys.exit(code)`
    const res = sb.runPython(harnessPy, { args: [JSON.stringify({ cli_args: validArgs })] })
    expect(res.status, diag(res)).toBe(3)
    expect(res.stderr.trim()).toBe('WARN_POST_COMMIT_SYNC')
    const out = JSON.parse(res.stdout.trim())
    expect(out).toEqual({
      status: 'warning',
      state_file: join(deployDir, 'release.env'),
      committed: true,
      durable: false,
      error: 'WARN_POST_COMMIT_SYNC',
    })
    const targetFile = join(deployDir, 'release.env')
    expect(existsSync(targetFile)).toBe(true)
    expect(statSync(targetFile).mode & 0o777).toBe(0o600)
  })

  it('propagates control BaseExceptions (KeyboardInterrupt, SystemExit) out of main', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const validArgs = buildValidCliArgs(deployDir, fixture)
    const harnessCtrlPy = `import sys, json
import scripts.web_only_state_publisher as wsp
assert callable(getattr(wsp, "main", None)), "scripts.web_only_state_publisher.main entrypoint is missing (control signal propagation requires main)"
data = json.loads(sys.argv[1])
rp = wsp.publish_v2_release_state

# KeyboardInterrupt propagation with exact identity and hitcounter
sentinel_ki = KeyboardInterrupt("simulated cancel")
hits_ki = [0]
def mock_ki(*a, **k):
    hits_ki[0] += 1
    raise sentinel_ki
wsp.publish_v2_release_state = mock_ki
try:
    wsp.main(data["cli_args"])
    raise AssertionError("main must propagate KeyboardInterrupt")
except BaseException as exc:
    assert hits_ki[0] == 1, f"expected exactly 1 injection call, got {hits_ki[0]}"
    assert exc is sentinel_ki, "main must propagate exact identity of KeyboardInterrupt"
finally:
    wsp.publish_v2_release_state = rp

# SystemExit propagation with exact identity and hitcounter
sentinel_se = SystemExit(99)
hits_se = [0]
def mock_se(*a, **k):
    hits_se[0] += 1
    raise sentinel_se
wsp.publish_v2_release_state = mock_se
try:
    wsp.main(data["cli_args"])
    raise AssertionError("main must propagate SystemExit")
except BaseException as exc:
    assert hits_se[0] == 1, f"expected exactly 1 injection call, got {hits_se[0]}"
    assert exc is sentinel_se, "main must propagate exact identity of SystemExit"
    assert exc.code == 99, f"main must propagate SystemExit(99), got {exc.code}"
finally:
    wsp.publish_v2_release_state = rp

print("CTRL_PROPAGATED_OK")`
    const resCtrl = sb.runPython(harnessCtrlPy, { args: [JSON.stringify({ cli_args: validArgs })] })
    expect(resCtrl.status, diag(resCtrl)).toBe(0)
    expect(resCtrl.stdout.trim()).toBe('CTRL_PROPAGATED_OK')
  })
})
