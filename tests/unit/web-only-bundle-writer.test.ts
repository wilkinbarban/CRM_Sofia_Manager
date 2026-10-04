import { describe, expect, it, afterEach } from 'vitest'
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
  symlinkSync, chmodSync, existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const PYTHON_BIN = '/usr/bin/python3'

let tempDir: string | null = null
function getSandbox(): { root: string } {
  tempDir = mkdtempSync(join(tmpdir(), 'bundle-writer-'))
  chmodSync(tempDir, 0o700)
  return { root: tempDir }
}

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

function runPython(code: string, env: Record<string, string> = {}) {
  return spawnSync(PYTHON_BIN, ['-B', '-c', code], {
    env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', ...env },
    encoding: 'utf8',
  })
}

// Unit 1a: Validator and dirfd component walk with primary-error and fault matrix.
// (Unit 1b deferred: write_all loop, 0700/0600 bundle writing, inode pinning, manifest LAST)
describe('web-only-bundle-writer Unit 1a validator and dirfd walk', () => {
  it('validates canonical target, returns open parent_fd, and caller assumes ownership', () => {
    const sb = getSandbox()
    const target = join(sb.root, 'new-bundle')
    const code = `
import os
from scripts.web_only_bundle_writer import validate_bundle_target
parent_fd, base = validate_bundle_target("${target}")
assert parent_fd > 0
assert base == "new-bundle"
os.close(parent_fd)
print("CALLER_CLOSED_SUCCESS")
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('CALLER_CLOSED_SUCCESS')
  })

  it('rejects root directory as immediate parent explicitly fail-closed', () => {
    const code = `
from scripts.web_only_bundle_writer import validate_bundle_target
try:
    validate_bundle_target("/bundle-at-root")
    print("FAILED_ALLOWED_ROOT")
except PermissionError as e:
    assert "root directory cannot be immediate parent" in str(e)
    print("REJECTED_ROOT_IMMEDIATE_PARENT")
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('REJECTED_ROOT_IMMEDIATE_PARENT')
  })

  it.each([
    ['existing directory', (dir: string) => { const p = join(dir, 'col-dir'); mkdirSync(p); return p }],
    ['existing file', (dir: string) => { const p = join(dir, 'col-file'); writeFileSync(p, ''); return p }],
    ['existing symlink', (dir: string) => { const p = join(dir, 'col-sym'); symlinkSync('/dev/null', p); return p }],
  ])('preserves FileExistsError on collision on %s', (_, setupTarget) => {
    const sb = getSandbox()
    const target = setupTarget(sb.root)
    const code = `
from scripts.web_only_bundle_writer import validate_bundle_target
try:
    validate_bundle_target("${target}")
    print("FAILED_NO_ERROR")
except FileExistsError as e:
    assert "already exists" in str(e)
    print("PRESERVED_FILE_EXISTS_ERROR")
except Exception as e:
    print(f"WRONG_ERROR: {type(e).__name__}: {e}")
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('PRESERVED_FILE_EXISTS_ERROR')
  })

  it.each([
    ['relative path', () => 'rel-bundle', /must be an absolute/],
    ['world-writable parent', (dir: string) => { const p = join(dir, 'ww-p'); mkdirSync(p); chmodSync(p, 0o777); return join(p, 'sub') }, /group or world writable/],
    ['symlink ancestor component', (dir: string) => { const realP = join(dir, 'real-p'); mkdirSync(realP); const sym = join(dir, 'sym-anc'); symlinkSync(realP, sym); return join(sym, 'sub') }, /symlink/],
  ])('rejects insecure path invariants in dirfd component walk on %s', (_, setupTarget, errRegex) => {
    const sb = getSandbox()
    const target = setupTarget(sb.root)
    const code = `
from scripts.web_only_bundle_writer import validate_bundle_target
validate_bundle_target("${target}")
`
    const ret = runPython(code)
    expect(ret.status).not.toBe(0)
    expect(ret.stderr).toMatch(errRegex)
  })

  it('permits root-owned sticky ancestor when immediate parent is private', () => {
    const sb = getSandbox()
    const target = join(sb.root, 'valid-sticky-ancestor-bundle')
    const code = `
import os
from scripts.web_only_bundle_writer import validate_bundle_target
pfd, base = validate_bundle_target("${target}")
os.close(pfd)
print("STICKY_ANCESTOR_PERMITTED")
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('STICKY_ANCESTOR_PERMITTED')
  })

  it.each([
    ['OSError', 'OSError(5, "simulated transition close failure")', 'OSError', 'simulated transition close failure'],
    ['KeyboardInterrupt', 'KeyboardInterrupt("simulated transition interrupt")', 'KeyboardInterrupt', 'simulated transition interrupt'],
    ['SystemExit', 'SystemExit(1)', 'SystemExit', '1'],
  ])('fails closed and propagates %s when close fails during walk component transition', (_, errExpr, errClass, errSubstr) => {
    const sb = getSandbox()
    const target = join(sb.root, 'trans-fail-bundle')
    const code = `
import os
from scripts.web_only_bundle_writer import validate_bundle_target
def count_fds():
    return len(os.listdir("/proc/self/fd"))
orig_close = os.close
calls = [0]
closed_fds = []
def failing_close(fd):
    calls[0] += 1
    orig_close(fd)
    closed_fds.append(fd)
    if calls[0] == 1:
        raise ${errExpr}
os.close = failing_close
before = count_fds()
try:
    validate_bundle_target("${target}")
    print("FAILED_RETURNED_SUCCESS")
except ${errClass} as e:
    assert type(e).__name__ == "${errClass}"
    assert "${errSubstr}" in str(e)
    after = count_fds()
    assert before == after, f"FD leak detected: before={before}, after={after}"
    assert len(closed_fds) == len(set(closed_fds)), "duplicate close fd attempts"
    print("TRANSITION_CLOSE_ERROR_PROPAGATED")
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('TRANSITION_CLOSE_ERROR_PROPAGATED')
  })

  it('preserves primary FileExistsError when close raises on collision and maintains stable FD count', () => {
    const sb = getSandbox()
    const target = join(sb.root, 'col-close-fail')
    mkdirSync(target)
    const code = `
import os
from scripts.web_only_bundle_writer import validate_bundle_target
def count_fds():
    return len(os.listdir("/proc/self/fd"))

target_stat_called = [False]
orig_stat = os.stat
def tracking_stat(path, *args, **kwargs):
    if kwargs.get("dir_fd") is not None and path == "col-close-fail":
        target_stat_called[0] = True
    return orig_stat(path, *args, **kwargs)
os.stat = tracking_stat

orig_close = os.close
def failing_close(fd):
    orig_close(fd)
    if target_stat_called[0]:
        raise OSError(5, "simulated collision close error")
os.close = failing_close

before = count_fds()
try:
    validate_bundle_target("${target}")
    print("FAILED_NO_ERROR")
except FileExistsError as e:
    assert "already exists" in str(e)
    after = count_fds()
    assert before == after, f"FD leak detected: before={before}, after={after}"
    print("PRESERVED_PRIMARY_FILE_EXISTS_ON_CLOSE_ERROR")
except OSError as e:
    print(f"REPLACED_BY_SECONDARY_ERROR: {e}")
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('PRESERVED_PRIMARY_FILE_EXISTS_ON_CLOSE_ERROR')
  })

  it.each([
    [
      'open EIO during component walk',
      `
orig_open = os.open
def fault_open(path, flags, *args, **kwargs):
    if isinstance(path, str) and path not in ("/", "/proc/self/fd"):
        raise OSError(5, "simulated open EIO")
    return orig_open(path, flags, *args, **kwargs)
os.open = fault_open
`,
      'OSError',
      'simulated open EIO',
    ],
    [
      'fstat PermissionError during component walk',
      `
orig_fstat = os.fstat
def fault_fstat(fd):
    st = orig_fstat(fd)
    if fd > 2:
        raise PermissionError("simulated fstat permission error")
    return st
os.fstat = fault_fstat
`,
      'PermissionError',
      'simulated fstat permission error',
    ],
    [
      'fstat EIO during component walk',
      `
orig_fstat = os.fstat
def fault_fstat(fd):
    st = orig_fstat(fd)
    if fd > 2:
        raise OSError(5, "simulated fstat EIO")
    return st
os.fstat = fault_fstat
`,
      'OSError',
      'simulated fstat EIO',
    ],
    [
      'fstat KeyboardInterrupt during component walk',
      `
orig_fstat = os.fstat
def fault_fstat(fd):
    st = orig_fstat(fd)
    if fd > 2:
        raise KeyboardInterrupt("simulated fstat interrupt")
    return st
os.fstat = fault_fstat
`,
      'KeyboardInterrupt',
      'simulated fstat interrupt',
    ],
    [
      'final stat PermissionError',
      `
orig_stat = os.stat
def fault_stat(path, *args, **kwargs):
    if kwargs.get("dir_fd") is not None and path == "fault-target":
        raise PermissionError("simulated final stat permission error")
    return orig_stat(path, *args, **kwargs)
os.stat = fault_stat
`,
      'PermissionError',
      'simulated final stat permission error',
    ],
    [
      'final stat EIO',
      `
orig_stat = os.stat
def fault_stat(path, *args, **kwargs):
    if kwargs.get("dir_fd") is not None and path == "fault-target":
        raise OSError(5, "simulated final stat EIO")
    return orig_stat(path, *args, **kwargs)
os.stat = fault_stat
`,
      'OSError',
      'simulated final stat EIO',
    ],
  ])('fault matrix: handles %s fail-closed with zero FD leak', (_, injectCode, errClass, errSubstr) => {
    const sb = getSandbox()
    const target = join(sb.root, 'fault-target')
    const code = `
import os
from scripts.web_only_bundle_writer import validate_bundle_target
def count_fds():
    return len(os.listdir("/proc/self/fd"))
${injectCode}
before = count_fds()
try:
    validate_bundle_target("${target}")
    print("FAILED_NO_ERROR")
except ${errClass} as e:
    assert "${errSubstr}" in str(e), f"Unexpected message: {e}"
    after = count_fds()
    assert before == after, f"FD leak detected: before={before}, after={after}"
    print("FAULT_HANDLED_ZERO_LEAK")
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('FAULT_HANDLED_ZERO_LEAK')
  })
})
