import { describe, expect, it, afterEach } from 'vitest'
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync,
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

describe('web-only-bundle-writer Unit 1b-i inert primitives and publication', () => {
  it.each([
    ['partial writes', 'mv = memoryview(data); return orig_write(fd, mv[:min(len(mv), 64)])', false],
    ['zero progress fail-closed', 'calls[0] += 1; return 0 if calls[0] > 1 else orig_write(fd, memoryview(data)[:10])', true],
  ])('handles %s in write_all fail-closed', (_, writeImpl, expectError) => {
    const sb = getSandbox()
    const filePath = join(sb.root, 'write-test.txt')
    const payload = 'A'.repeat(512)
    const code = `
import os, scripts.web_only_bundle_writer as bw
orig_write = os.write
calls = [0]
def injected_write(fd, data):
    ${writeImpl}
os.write = injected_write
fd = os.open("${filePath}", os.O_WRONLY | os.O_CREAT, 0o600)
try:
    bw.write_all(fd, "${payload}".encode())
    print("SUCCESS")
except OSError as e:
    assert "zero progress or failed" in str(e)
    print("ZERO_PROGRESS_ERROR")
finally:
    os.close(fd)
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    if (expectError) {
      expect(ret.stdout.trim()).toBe('ZERO_PROGRESS_ERROR')
    } else {
      expect(ret.stdout.trim()).toBe('SUCCESS')
      expect(readFileSync(filePath, 'utf8')).toBe(payload)
    }
  })

  it('pops FD before close attempt and survives sentinel reuse without double close', () => {
    const sb = getSandbox()
    const dirPath = join(sb.root, 'reg-dir')
    mkdirSync(dirPath)
    const filePath = join(sb.root, 'reg-file.txt')
    writeFileSync(filePath, 'data')
    const code = `
import os, scripts.web_only_bundle_writer as bw
reg = bw.FDOwnershipRegistry()
dir_fd = os.open("${dirPath}", os.O_RDONLY | os.O_DIRECTORY)
file_fd = os.open("${filePath}", os.O_RDONLY)
reg.register(dir_fd)
reg.register(file_fd)

orig_close = os.close
closed_history = []
def fault_close(fd):
    closed_history.append(fd)
    orig_close(fd)
    if fd == file_fd:
        raise OSError(5, "simulated file close failure")
os.close = fault_close

try:
    reg.close(file_fd)
except OSError:
    pass

reused_fd = os.open("${filePath}", os.O_RDONLY)
assert reused_fd == file_fd, f"expected sentinel reuse {file_fd}, got {reused_fd}"
reg.safe_close_all()
assert os.fstat(reused_fd).st_size == 4
os.close = orig_close
os.close(reused_fd)
assert closed_history.count(file_fd) == 1, "double close attempt detected"
print("SENTINEL_REUSE_OK")
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('SENTINEL_REUSE_OK')
  })

  it.each([
    ['KeyboardInterrupt', 'KeyboardInterrupt("ctrl-c")', true],
    ['SystemExit', 'SystemExit(42)', true],
    ['OSError', 'OSError(6, "later error")', false],
  ])('normal close_all drains all FDs with single attempt and prioritizes control-flow: %s', (name, secondErrExpr, isControl) => {
    const sb = getSandbox()
    const dirPath = join(sb.root, 'reg-dir')
    mkdirSync(dirPath)
    const filePath = join(sb.root, 'reg-file.txt')
    writeFileSync(filePath, 'data')
    const code = `
import os, scripts.web_only_bundle_writer as bw
reg = bw.FDOwnershipRegistry()
f1 = os.open("${dirPath}", os.O_RDONLY | os.O_DIRECTORY)
f2 = os.open("${filePath}", os.O_RDONLY)
reg.register(f1)
reg.register(f2)

orig_close = os.close
hist = []
err1 = OSError(5, "first error")
err2 = ${secondErrExpr}
def multi_close(fd):
    hist.append(fd)
    orig_close(fd)
    if fd == f2:
        raise err1
    if fd == f1:
        raise err2
os.close = multi_close

try:
    reg.close_all()
    print("UNEXPECTED_SUCCESS")
except BaseException as caught:
    expected = err2 if ${isControl ? 'True' : 'False'} else err1
    assert caught is expected, f"expected {expected!r}, got {caught!r}"
    assert len(reg) == 0, "all FDs must be drained"
    assert hist.count(f1) == 1 and hist.count(f2) == 1, "single attempt per FD"
    print("NORMAL_CLOSE_PRIORITY_OK")
finally:
    os.close = orig_close
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('NORMAL_CLOSE_PRIORITY_OK')
  })

  it.each([
    ['OSError', 'OSError(5, "primary")', 'OSError', 'OSError(6, "secondary")'],
    ['OSError', 'OSError(5, "primary")', 'KeyboardInterrupt', 'KeyboardInterrupt("secondary")'],
    ['OSError', 'OSError(5, "primary")', 'SystemExit', 'SystemExit(1)'],
    ['KeyboardInterrupt', 'KeyboardInterrupt("primary")', 'OSError', 'OSError(6, "secondary")'],
    ['KeyboardInterrupt', 'KeyboardInterrupt("primary")', 'KeyboardInterrupt', 'KeyboardInterrupt("secondary")'],
    ['KeyboardInterrupt', 'KeyboardInterrupt("primary")', 'SystemExit', 'SystemExit(1)'],
    ['SystemExit', 'SystemExit(2)', 'OSError', 'OSError(6, "secondary")'],
    ['SystemExit', 'SystemExit(2)', 'KeyboardInterrupt', 'KeyboardInterrupt("secondary")'],
    ['SystemExit', 'SystemExit(2)', 'SystemExit', 'SystemExit(1)'],
  ])('explicit cleanup preserves primary %s over secondary %s and drains all FDs', (_pName, pExpr, _sName, sExpr) => {
    const sb = getSandbox()
    const dirPath = join(sb.root, 'reg-dir')
    mkdirSync(dirPath)
    const filePath = join(sb.root, 'reg-file.txt')
    writeFileSync(filePath, 'data')
    const code = `
import os, scripts.web_only_bundle_writer as bw
reg = bw.FDOwnershipRegistry()
f1 = os.open("${dirPath}", os.O_RDONLY | os.O_DIRECTORY)
f2 = os.open("${filePath}", os.O_RDONLY)
reg.register(f1)
reg.register(f2)

orig_close = os.close
hist = []
primary = ${pExpr}
secondary = ${sExpr}
def fault_close(fd):
    hist.append(fd)
    orig_close(fd)
    raise secondary
os.close = fault_close

try:
    try:
        raise primary
    except BaseException as active_err:
        reg.safe_close_all(primary_err=active_err)
        raise active_err
except BaseException as caught:
    assert caught is primary, f"expected {primary!r}, got {caught!r}"
    assert len(reg) == 0, "all FDs must be drained"
    assert hist.count(f1) == 1 and hist.count(f2) == 1, "single attempt per FD"
    print("EXPLICIT_CLEANUP_OK")
finally:
    os.close = orig_close
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('EXPLICIT_CLEANUP_OK')
  })

  it.each([
    ['KeyboardInterrupt', 'KeyboardInterrupt("interrupt")', true],
    ['SystemExit', 'SystemExit(3)', true],
    ['OSError', 'OSError(5, "io error")', false],
  ])('standalone cleanup propagates control-flow and suppresses ordinary: %s', (_, errExpr, isControl) => {
    const sb = getSandbox()
    const filePath = join(sb.root, 'reg-file.txt')
    writeFileSync(filePath, 'data')
    const code = `
import os, scripts.web_only_bundle_writer as bw
orig_close = os.close
err = ${errExpr}
def fault_close(fd):
    orig_close(fd)
    raise err
os.close = fault_close

f1 = os.open("${filePath}", os.O_RDONLY)
f1_propagated = False
try:
    bw.safe_close_cleanup(f1)
except BaseException as caught:
    assert caught is err
    f1_propagated = True

reg = bw.FDOwnershipRegistry()
f2 = os.open("${filePath}", os.O_RDONLY)
reg.register(f2)
reg_propagated = False
try:
    reg.safe_close_all()
except BaseException as caught:
    assert caught is err
    reg_propagated = True

os.close = orig_close
assert f1_propagated == ${isControl ? 'True' : 'False'}, f"safe_close_cleanup propagation mismatch: {f1_propagated}"
assert reg_propagated is True, f"safe_close_all ordinary semantics mismatch: {reg_propagated}"
print("STANDALONE_CLEANUP_OK")
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('STANDALONE_CLEANUP_OK')
  })

  it('unlinks only verified matching devino and preserves foreign files and symlinks', () => {
    const sb = getSandbox()
    const targetFile = join(sb.root, 'target.txt')
    writeFileSync(targetFile, 'target')
    const foreignFile = join(sb.root, 'foreign.txt')
    writeFileSync(foreignFile, 'foreign')
    const symlinkFile = join(sb.root, 'sym.txt')
    symlinkSync(targetFile, symlinkFile)
    const code = `
import os, scripts.web_only_bundle_writer as bw
dir_fd = os.open("${sb.root}", os.O_RDONLY | os.O_DIRECTORY)
st_t = os.stat("target.txt", dir_fd=dir_fd, follow_symlinks=False)
st_f = os.stat("foreign.txt", dir_fd=dir_fd, follow_symlinks=False)

# None dev/ino identity preserves target
assert bw.safe_unlink_devino(dir_fd, "target.txt", None, None) is False

# Nonexistent file returns False
assert bw.safe_unlink_devino(dir_fd, "nonexistent.txt", st_t.st_dev, st_t.st_ino) is False

# Mismatch preserves foreign file
res_foreign = bw.safe_unlink_devino(dir_fd, "foreign.txt", st_t.st_dev, st_t.st_ino)
assert res_foreign is False
assert os.path.exists("${foreignFile}")

# Symlink is never unlinked even if devino matched target
res_sym = bw.safe_unlink_devino(dir_fd, "sym.txt", st_t.st_dev, st_t.st_ino)
assert res_sym is False
assert os.path.islink("${symlinkFile}")

# Matching identity unlinks own file
res_own = bw.safe_unlink_devino(dir_fd, "target.txt", st_t.st_dev, st_t.st_ino)
assert res_own is True
assert not os.path.exists("${targetFile}")
os.close(dir_fd)
print("SAFE_UNLINK_PRESERVES_FOREIGN")
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('SAFE_UNLINK_PRESERVES_FOREIGN')
  })
})
