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

describe('web-only-bundle-writer Unit 1b-ii write_private_entry', () => {
  it.each([
    ['with registry', true],
    ['without registry', false],
  ])('Area 1: creates 0600 file, writes data, computes sha256 and devino, and rejects path escape: %s', (_, useReg) => {
    const sb = getSandbox()
    const bdir = join(sb.root, 'bdir-success')
    mkdirSync(bdir, 0o700)
    const code = `
import os, hashlib, scripts.web_only_bundle_writer as bw
reg = bw.FDOwnershipRegistry() if ${useReg ? 'True' : 'False'} else None
bfd = os.open("${bdir}", os.O_RDONLY | os.O_DIRECTORY)
data = b"secure payload content"
dev, ino, sha = bw.write_private_entry(bfd, "secret.dat", data, registry=reg)
st = os.stat("secret.dat", dir_fd=bfd, follow_symlinks=False)
assert (st.st_dev, st.st_ino) == (dev, ino)
assert (st.st_mode & 0o777) == 0o600
assert st.st_uid == os.geteuid()
assert sha == hashlib.sha256(data).hexdigest()
assert open(os.path.join("${bdir}", "secret.dat"), "rb").read() == data
if reg is not None:
    assert len(reg) == 0
for bad in ["../escape", "/abs/path", "dir/sub", ".", "..", ""]:
    try:
        bw.write_private_entry(bfd, bad, data, registry=reg)
        assert False, f"should reject {bad}"
    except ValueError:
        pass
os.close(bfd)
print("SUCCESS_0600")
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('SUCCESS_0600')
  })

  it.each([
    ['with registry', true],
    ['without registry', false],
  ])('Area 2: collision preserves foreign file and leaks zero descriptors: %s', (_, useReg) => {
    const sb = getSandbox()
    const bdir = join(sb.root, 'bdir-col')
    mkdirSync(bdir, 0o700)
    const existingFile = join(bdir, 'existing.dat')
    writeFileSync(existingFile, 'foreign content')
    const code = `
import os, scripts.web_only_bundle_writer as bw
def count_fds(): return len(os.listdir("/proc/self/fd"))
reg = bw.FDOwnershipRegistry() if ${useReg ? 'True' : 'False'} else None
bfd = os.open("${bdir}", os.O_RDONLY | os.O_DIRECTORY)
orig_st = os.stat("existing.dat", dir_fd=bfd, follow_symlinks=False)
before = count_fds()
try:
    bw.write_private_entry(bfd, "existing.dat", b"overwrite attempt", registry=reg)
    print("UNEXPECTED")
except FileExistsError:
    assert before == count_fds()
    after_st = os.stat("existing.dat", dir_fd=bfd, follow_symlinks=False)
    assert (orig_st.st_dev, orig_st.st_ino) == (after_st.st_dev, after_st.st_ino)
    assert open(os.path.join("${bdir}", "existing.dat"), "rb").read() == b"foreign content"
    if reg is not None:
        assert len(reg) == 0
    print("COLLISION_PRESERVED")
finally:
    os.close(bfd)
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('COLLISION_PRESERVED')
  })

  it.each([
    ['with registry', true],
    ['without registry', false],
  ])('Area 3: fstat failure preserves unknown file without blind unlink and zero leaks: %s', (_, useReg) => {
    const sb = getSandbox()
    const bdir = join(sb.root, 'bdir-fstat')
    mkdirSync(bdir, 0o700)
    const code = `
import os, scripts.web_only_bundle_writer as bw
def count_fds(): return len(os.listdir("/proc/self/fd"))
reg = bw.FDOwnershipRegistry() if ${useReg ? 'True' : 'False'} else None
bfd = os.open("${bdir}", os.O_RDONLY | os.O_DIRECTORY)
orig_fstat = os.fstat
def fault_fstat(fd):
    st = orig_fstat(fd)
    if fd != bfd and orig_fstat(bfd).st_dev == st.st_dev:
        raise OSError(5, "simulated fstat failure")
    return st
os.fstat = fault_fstat
before = count_fds()
try:
    bw.write_private_entry(bfd, "unknown.dat", b"payload", registry=reg)
    print("UNEXPECTED")
except OSError as e:
    assert "simulated fstat failure" in str(e)
    assert before == count_fds()
    assert os.path.exists(os.path.join("${bdir}", "unknown.dat")), "unknown file was blindly deleted"
    if reg is not None:
        assert len(reg) == 0
    print("FSTAT_FAULT_PRESERVED")
finally:
    os.fstat = orig_fstat
    os.close(bfd)
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('FSTAT_FAULT_PRESERVED')
  })

  it.each([
    ['with registry', true],
    ['without registry', false],
  ])('Area 4: mode or UID mismatch preserves unknown file and zero leaks: %s', (_, useReg) => {
    const sb = getSandbox()
    const bdir = join(sb.root, 'bdir-perm')
    mkdirSync(bdir, 0o700)
    const code = `
import os, stat, scripts.web_only_bundle_writer as bw
def count_fds(): return len(os.listdir("/proc/self/fd"))
reg = bw.FDOwnershipRegistry() if ${useReg ? 'True' : 'False'} else None
bfd = os.open("${bdir}", os.O_RDONLY | os.O_DIRECTORY)
orig_fstat = os.fstat
def mock_fstat(fd):
    st = orig_fstat(fd)
    if fd != bfd and orig_fstat(bfd).st_dev == st.st_dev:
        class FakeStat:
            st_uid = st.st_uid + 1
            st_mode = stat.S_IFREG | 0o644
            st_dev = st.st_dev
            st_ino = st.st_ino
        return FakeStat()
    return st
os.fstat = mock_fstat
before = count_fds()
try:
    bw.write_private_entry(bfd, "mismatch.dat", b"payload", registry=reg)
    print("UNEXPECTED")
except PermissionError as e:
    assert "file permission or type mismatch" in str(e)
    assert before == count_fds()
    assert os.path.exists(os.path.join("${bdir}", "mismatch.dat")), "unknown file was blindly deleted"
    if reg is not None:
        assert len(reg) == 0
    print("MISMATCH_PRESERVED")
finally:
    os.fstat = orig_fstat
    os.close(bfd)
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('MISMATCH_PRESERVED')
  })

  it.each([
    ['with registry', true],
    ['without registry', false],
  ])('Area 5: normal close failure raises close error, avoids double close on reused FD, and cleans verified file: %s', (_, useReg) => {
    const sb = getSandbox()
    const bdir = join(sb.root, 'bdir-nc')
    mkdirSync(bdir, 0o700)
    const sentinelPath = join(bdir, 'sentinel.txt')
    writeFileSync(sentinelPath, 'sentinel')
    const code = `
import os, scripts.web_only_bundle_writer as bw
def count_fds(): return len(os.listdir("/proc/self/fd"))
reg = bw.FDOwnershipRegistry() if ${useReg ? 'True' : 'False'} else None
bfd = os.open("${bdir}", os.O_RDONLY | os.O_DIRECTORY)
orig_close = os.close
close_history = []
entry_fd = [-1]
def fault_close(fd):
    close_history.append(fd)
    orig_close(fd)
    if fd != bfd:
        entry_fd[0] = fd
        raise OSError(5, "simulated normal close failure")
os.close = fault_close
before = count_fds()
try:
    bw.write_private_entry(bfd, "entry.dat", b"valid data", registry=reg)
    print("UNEXPECTED")
except OSError as e:
    assert "simulated normal close failure" in str(e)
    reused_fd = os.open("${sentinelPath}", os.O_RDONLY)
    assert reused_fd == entry_fd[0], f"expected reused FD {entry_fd[0]}, got {reused_fd}"
    assert os.fstat(reused_fd).st_size == 8
    assert close_history.count(entry_fd[0]) == 1, "double close attempt detected"
    assert not os.path.exists(os.path.join("${bdir}", "entry.dat")), "verified file was not cleaned up"
    if reg is not None:
        reg.safe_close_all()
        assert os.fstat(reused_fd).st_size == 8
        assert len(reg) == 0
    os.close = orig_close
    os.close(reused_fd)
    assert before == count_fds()
    print("NORMAL_CLOSE_REUSE_OK")
finally:
    os.close = orig_close
    os.close(bfd)
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('NORMAL_CLOSE_REUSE_OK')
  })

  it.each([
    ['with registry', true],
    ['without registry', false],
  ])('Area 6: exception cleanup preserves primary error, single close attempt on sentinel reuse: %s', (_, useReg) => {
    const sb = getSandbox()
    const bdir = join(sb.root, 'bdir-exc')
    mkdirSync(bdir, 0o700)
    const sentinelPath = join(bdir, 'sentinel.txt')
    writeFileSync(sentinelPath, 'sentinel')
    const code = `
import os, scripts.web_only_bundle_writer as bw
def count_fds(): return len(os.listdir("/proc/self/fd"))
reg = bw.FDOwnershipRegistry() if ${useReg ? 'True' : 'False'} else None
bfd = os.open("${bdir}", os.O_RDONLY | os.O_DIRECTORY)
orig_write = os.write
def fault_write(fd, data):
    raise OSError(28, "primary no space left on device")
os.write = fault_write

orig_close = os.close
close_history = []
entry_fd = [-1]
def fault_close(fd):
    close_history.append(fd)
    orig_close(fd)
    if fd != bfd:
        entry_fd[0] = fd
        raise OSError(5, "secondary close error")
os.close = fault_close

before = count_fds()
try:
    bw.write_private_entry(bfd, "fail.dat", b"data", registry=reg)
    print("UNEXPECTED")
except OSError as e:
    assert "primary no space left on device" in str(e)
    reused_fd = os.open("${sentinelPath}", os.O_RDONLY)
    assert reused_fd == entry_fd[0], f"expected reused FD {entry_fd[0]}, got {reused_fd}"
    assert os.fstat(reused_fd).st_size == 8
    assert close_history.count(entry_fd[0]) == 1, "double close attempt detected"
    assert not os.path.exists(os.path.join("${bdir}", "fail.dat"))
    if reg is not None:
        reg.safe_close_all()
        assert os.fstat(reused_fd).st_size == 8
        assert len(reg) == 0
    os.close = orig_close
    os.close(reused_fd)
    assert before == count_fds()
    print("EXCEPTION_CLEANUP_OK")
finally:
    os.write = orig_write
    os.close = orig_close
    os.close(bfd)
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('EXCEPTION_CLEANUP_OK')
  })

  it('preserves foreign replacement file on cleanup when identity differs', () => {
    const sb = getSandbox()
    const bdir = join(sb.root, 'bdir-rep')
    mkdirSync(bdir, 0o700)
    const code = `
import os, scripts.web_only_bundle_writer as bw
bfd = os.open("${bdir}", os.O_RDONLY | os.O_DIRECTORY)
orig_write = os.write
def fault_write(fd, data):
    os.unlink(os.path.join("${bdir}", "replaced.dat"))
    with open(os.path.join("${bdir}", "replaced.dat"), "w") as f:
        f.write("foreign replacement")
    raise OSError(28, "primary write error")
os.write = fault_write
try:
    bw.write_private_entry(bfd, "replaced.dat", b"initial data")
    print("UNEXPECTED")
except OSError as e:
    assert "primary write error" in str(e)
    assert open(os.path.join("${bdir}", "replaced.dat"), "r").read() == "foreign replacement"
    print("FOREIGN_REPLACEMENT_PRESERVED")
finally:
    os.write = orig_write
    os.close(bfd)
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('FOREIGN_REPLACEMENT_PRESERVED')
  })

  it('closes descriptor and leaks zero descriptors when registry.register fails', () => {
    const sb = getSandbox()
    const bdir = join(sb.root, 'bdir-regfail')
    mkdirSync(bdir, 0o700)
    const code = `
import os, scripts.web_only_bundle_writer as bw
def count_fds(): return len(os.listdir("/proc/self/fd"))
reg = bw.FDOwnershipRegistry()
def fault_register(fd):
    raise RuntimeError("simulated register failure")
reg.register = fault_register
bfd = os.open("${bdir}", os.O_RDONLY | os.O_DIRECTORY)
before = count_fds()
try:
    bw.write_private_entry(bfd, "regfail.dat", b"data", registry=reg)
    print("UNEXPECTED")
except RuntimeError as e:
    assert "simulated register failure" in str(e)
    assert before == count_fds(), "FD leak on register failure"
    assert os.path.exists(os.path.join("${bdir}", "regfail.dat")), "unknown file preserved"
    print("REGISTER_FAILURE_NO_LEAK")
finally:
    os.close(bfd)
`
    const ret = runPython(code)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('REGISTER_FAILURE_NO_LEAK')
  })
})

describe('web-only-bundle-writer Unit 1c strict_link_manifest', () => {
  it('successfully links manifest atomically, cleans temp alias, and returns expected identity', () => {
    const sb = getSandbox(), bundleDir = join(sb.root, 'link-success')
    mkdirSync(bundleDir, 0o700)
    const ret = runPython(`import os, scripts.web_only_bundle_writer as bw
bfd = os.open("${bundleDir}", os.O_RDONLY | os.O_DIRECTORY)
dev, ino, _ = bw.write_private_entry(bfd, ".manifest.tmp", b'manifest content')
res = bw.strict_link_manifest(bfd, ".manifest.tmp", "manifest.json", (dev, ino))
assert res == (dev, ino), f"expected {(dev, ino)}, got {res}"
st = os.stat("manifest.json", dir_fd=bfd, follow_symlinks=False)
assert (st.st_dev, st.st_ino) == (dev, ino)
assert not os.path.exists(os.path.join("${bundleDir}", ".manifest.tmp"))
os.close(bfd)
print("LINK_SUCCESS")`)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('LINK_SUCCESS')
    expect(readFileSync(join(bundleDir, 'manifest.json'), 'utf8')).toBe('manifest content')
    expect(existsSync(join(bundleDir, '.manifest.tmp'))).toBe(false)
  })

  it('strictly links manifest without replace fallback, rejecting collision EEXIST and preserving foreign files', () => {
    const sb = getSandbox(), bundleDir = join(sb.root, 'link-col'), finalFile = join(bundleDir, 'manifest.json')
    mkdirSync(bundleDir, 0o700); writeFileSync(finalFile, 'foreign manifest content')
    const ret = runPython(`import os, scripts.web_only_bundle_writer as bw
bfd = os.open("${bundleDir}", os.O_RDONLY | os.O_DIRECTORY)
dev, ino, _ = bw.write_private_entry(bfd, ".manifest.tmp", b'new manifest')
try:
    bw.strict_link_manifest(bfd, ".manifest.tmp", "manifest.json", (dev, ino))
    print("UNEXPECTED_LINK_SUCCESS")
except FileExistsError:
    print("COLLISION_EEXIST_HANDLED")
finally: os.close(bfd)`)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('COLLISION_EEXIST_HANDLED')
    expect(readFileSync(finalFile, 'utf8')).toBe('foreign manifest content')
  })

  it('fails closed on poststat failure, cleaning up own final and temp file', () => {
    const sb = getSandbox(), bundleDir = join(sb.root, 'link-poststat'); mkdirSync(bundleDir, 0o700)
    const ret = runPython(`import os, scripts.web_only_bundle_writer as bw
bfd = os.open("${bundleDir}", os.O_RDONLY | os.O_DIRECTORY)
dev, ino, _ = bw.write_private_entry(bfd, ".manifest.tmp", b'manifest data')
orig_stat, calls = os.stat, [0]
def fault_stat(path, *args, **kwargs):
    if path == "manifest.json":
        calls[0] += 1
        if calls[0] == 1: raise OSError(5, "simulated poststat error")
    return orig_stat(path, *args, **kwargs)
os.stat = fault_stat
try:
    bw.strict_link_manifest(bfd, ".manifest.tmp", "manifest.json", (dev, ino))
except OSError as e:
    assert "simulated poststat error" in str(e); print("POSTSTAT_ERROR_CAUGHT")
finally: os.stat = orig_stat; os.close(bfd)`)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('POSTSTAT_ERROR_CAUGHT')
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(false)
    expect(existsSync(join(bundleDir, '.manifest.tmp'))).toBe(false)
  })

  it('fails closed and preserves foreign replacement when postlink identity does not match', () => {
    const sb = getSandbox(), bundleDir = join(sb.root, 'link-replace'), foreignFile = join(sb.root, 'foreign.json')
    mkdirSync(bundleDir, 0o700); writeFileSync(foreignFile, 'foreign data')
    const ret = runPython(`import os, scripts.web_only_bundle_writer as bw
bfd = os.open("${bundleDir}", os.O_RDONLY | os.O_DIRECTORY)
dev, ino, _ = bw.write_private_entry(bfd, ".manifest.tmp", b'manifest data')
orig_link = os.link
def replace_on_link(src, dst, *args, **kwargs):
    orig_link(src, dst, *args, **kwargs)
    os.unlink(os.path.join("${bundleDir}", "manifest.json"))
    orig_link("${foreignFile}", os.path.join("${bundleDir}", "manifest.json"))
os.link = replace_on_link
try:
    bw.strict_link_manifest(bfd, ".manifest.tmp", "manifest.json", (dev, ino))
except PermissionError as e:
    assert "identity mismatch" in str(e); print("FOREIGN_REPLACEMENT_REJECTED")
finally: os.close(bfd)`)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('FOREIGN_REPLACEMENT_REJECTED')
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(true)
    expect(readFileSync(join(bundleDir, 'manifest.json'), 'utf8')).toBe('foreign data')
  })

  it('cleans up own final and propagates error when temp alias unlink fails, leaving no orphan final', () => {
    const sb = getSandbox(), bundleDir = join(sb.root, 'link-alias-fail'); mkdirSync(bundleDir, 0o700)
    const ret = runPython(`import os, scripts.web_only_bundle_writer as bw
bfd = os.open("${bundleDir}", os.O_RDONLY | os.O_DIRECTORY)
dev, ino, _ = bw.write_private_entry(bfd, ".manifest.tmp", b'manifest data')
orig_unlink = os.unlink
def fault_unlink(path, *args, **kwargs):
    if path == ".manifest.tmp": raise OSError(5, "simulated alias unlink error")
    return orig_unlink(path, *args, **kwargs)
os.unlink = fault_unlink
try:
    bw.strict_link_manifest(bfd, ".manifest.tmp", "manifest.json", (dev, ino))
except OSError as e:
    assert "simulated alias unlink error" in str(e); print("ALIAS_UNLINK_ERROR_CAUGHT")
finally: os.unlink = orig_unlink; os.close(bfd)`)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('ALIAS_UNLINK_ERROR_CAUGHT')
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(false)
  })

  it.each([
    [
      'source devino mismatch',
      (bdir: string) => `
dev, ino, _ = bw.write_private_entry(bfd, ".manifest.tmp", b'data')
try:
    bw.strict_link_manifest(bfd, ".manifest.tmp", "manifest.json", (dev, ino + 1))
    print("UNEXPECTED")
except PermissionError as e:
    assert "source identity mismatch" in str(e)
    print("SOURCE_MISMATCH_CAUGHT")
`,
      'SOURCE_MISMATCH_CAUGHT',
    ],
    [
      'symlink source entry',
      (bdir: string) => `
os.symlink("/dev/null", os.path.join("${bdir}", ".manifest.tmp"))
try:
    bw.strict_link_manifest(bfd, ".manifest.tmp", "manifest.json", (0, 0))
    print("UNEXPECTED")
except PermissionError as e:
    assert "source entry is a symlink" in str(e)
    print("SOURCE_SYMLINK_CAUGHT")
`,
      'SOURCE_SYMLINK_CAUGHT',
    ],
  ])('rejects %s before link', (_, makePyBody, expectedOutput) => {
    const sb = getSandbox(), bundleDir = join(sb.root, 'link-src-bad')
    mkdirSync(bundleDir, 0o700)
    const pyBody = makePyBody(bundleDir)
    const ret = runPython(`import os, scripts.web_only_bundle_writer as bw
bfd = os.open("${bundleDir}", os.O_RDONLY | os.O_DIRECTORY)
try:
${pyBody.trim().split('\n').map(l => '    ' + l).join('\n')}
finally:
    os.close(bfd)`)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe(expectedOutput)
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(false)
  })

  it('preserves unknown final on persistent poststat failure without blind deletion', () => {
    const sb = getSandbox(), bundleDir = join(sb.root, 'link-persist-stat')
    mkdirSync(bundleDir, 0o700)
    const ret = runPython(`import os, scripts.web_only_bundle_writer as bw
bfd = os.open("${bundleDir}", os.O_RDONLY | os.O_DIRECTORY)
dev, ino, _ = bw.write_private_entry(bfd, ".manifest.tmp", b'manifest data')
orig_stat = os.stat
def persistent_fault_stat(path, *args, **kwargs):
    if path == "manifest.json":
        raise OSError(5, "persistent poststat error")
    return orig_stat(path, *args, **kwargs)
os.stat = persistent_fault_stat
try:
    bw.strict_link_manifest(bfd, ".manifest.tmp", "manifest.json", (dev, ino))
    print("UNEXPECTED")
except OSError as e:
    assert "persistent poststat error" in str(e)
    print("PERSISTENT_POSTSTAT_CAUGHT")
finally:
    os.stat = orig_stat
    os.close(bfd)`)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('PERSISTENT_POSTSTAT_CAUGHT')
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(true)
    expect(existsSync(join(bundleDir, '.manifest.tmp'))).toBe(false)
  })

  it('fails closed and preserves foreign temp replacement when alias identity is modified before unlink', () => {
    const sb = getSandbox(), bundleDir = join(sb.root, 'link-alias-rep'), foreignFile = join(sb.root, 'foreign-alias.txt')
    mkdirSync(bundleDir, 0o700); writeFileSync(foreignFile, 'foreign alias data')
    const ret = runPython(`import os, scripts.web_only_bundle_writer as bw
bfd = os.open("${bundleDir}", os.O_RDONLY | os.O_DIRECTORY)
dev, ino, _ = bw.write_private_entry(bfd, ".manifest.tmp", b'manifest data')
orig_link = os.link
def replace_alias_on_link(src, dst, *args, **kwargs):
    orig_link(src, dst, *args, **kwargs)
    os.unlink(os.path.join("${bundleDir}", ".manifest.tmp"))
    orig_link("${foreignFile}", os.path.join("${bundleDir}", ".manifest.tmp"))
os.link = replace_alias_on_link
try:
    bw.strict_link_manifest(bfd, ".manifest.tmp", "manifest.json", (dev, ino))
    print("UNEXPECTED")
except PermissionError as e:
    assert "temp alias identity mismatch" in str(e)
    print("ALIAS_REPLACEMENT_REJECTED")
finally:
    os.close(bfd)`)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('ALIAS_REPLACEMENT_REJECTED')
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(false)
    expect(existsSync(join(bundleDir, '.manifest.tmp'))).toBe(true)
    expect(readFileSync(join(bundleDir, '.manifest.tmp'), 'utf8')).toBe('foreign alias data')
  })

  it('guards link_created and preserves preexisting final even if sharing inode on collision EEXIST', () => {
    const sb = getSandbox(), bundleDir = join(sb.root, 'link-same-ino')
    mkdirSync(bundleDir, 0o700)
    const ret = runPython(`import os, scripts.web_only_bundle_writer as bw
bfd = os.open("${bundleDir}", os.O_RDONLY | os.O_DIRECTORY)
dev, ino, _ = bw.write_private_entry(bfd, ".manifest.tmp", b'shared content')
os.link(".manifest.tmp", "manifest.json", src_dir_fd=bfd, dst_dir_fd=bfd)
try:
    bw.strict_link_manifest(bfd, ".manifest.tmp", "manifest.json", (dev, ino))
    print("UNEXPECTED")
except FileExistsError:
    print("PREEXISTING_SAME_INODE_EEXIST")
finally:
    os.close(bfd)`)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('PREEXISTING_SAME_INODE_EEXIST')
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(true)
    expect(existsSync(join(bundleDir, '.manifest.tmp'))).toBe(true)
  })

  it('fails closed on generic link OSError without attempting replace fallback', () => {
    const sb = getSandbox(), bundleDir = join(sb.root, 'link-generic-err')
    mkdirSync(bundleDir, 0o700)
    const ret = runPython(`import os, scripts.web_only_bundle_writer as bw
bfd = os.open("${bundleDir}", os.O_RDONLY | os.O_DIRECTORY)
dev, ino, _ = bw.write_private_entry(bfd, ".manifest.tmp", b'manifest data')
orig_link = os.link
def fault_link(src, dst, *args, **kwargs):
    raise OSError(31, "simulated link EMLINK error")
os.link = fault_link
replace_called = [False]
orig_replace = getattr(os, "replace", None)
def tracking_replace(*args, **kwargs):
    replace_called[0] = True
    if orig_replace: return orig_replace(*args, **kwargs)
os.replace = tracking_replace
try:
    bw.strict_link_manifest(bfd, ".manifest.tmp", "manifest.json", (dev, ino))
    print("UNEXPECTED")
except OSError as e:
    assert "simulated link EMLINK error" in str(e)
    assert not replace_called[0], "os.replace was called as fallback!"
    print("GENERIC_LINK_ERROR_NO_FALLBACK")
finally:
    os.link = orig_link
    if orig_replace: os.replace = orig_replace
    os.close(bfd)`)
    expect(ret.status).toBe(0)
    expect(ret.stdout.trim()).toBe('GENERIC_LINK_ERROR_NO_FALLBACK')
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(false)
    expect(existsSync(join(bundleDir, '.manifest.tmp'))).toBe(true)
  })

  it.each([
    ['invalid dir_fd negative', '-1', '.manifest.tmp', 'manifest.json', [1, 2], /invalid dir_fd/],
    ['invalid dir_fd bool', 'True', '.manifest.tmp', 'manifest.json', [1, 2], /invalid dir_fd/],
    ['invalid tmp_name empty', '0', '', 'manifest.json', [1, 2], /invalid tmp_name/],
    ['invalid final_name slash', '0', '.manifest.tmp', 'sub/manifest.json', [1, 2], /invalid final_name/],
    ['identical names', '0', 'manifest.json', 'manifest.json', [1, 2], /distinct/],
    ['invalid expected_identity length', '0', '.manifest.tmp', 'manifest.json', [1], /invalid expected_identity/],
  ])('validates arguments fail-closed: %s', (_, dfdExpr, tmpN, finN, ident, errRegex) => {
    const code = `
import scripts.web_only_bundle_writer as bw
bw.strict_link_manifest(${dfdExpr}, ${JSON.stringify(tmpN)}, ${JSON.stringify(finN)}, tuple(${JSON.stringify(ident)}))
`
    const ret = runPython(code)
    expect(ret.status).not.toBe(0)
    expect(ret.stderr).toMatch(errRegex)
  })
})

