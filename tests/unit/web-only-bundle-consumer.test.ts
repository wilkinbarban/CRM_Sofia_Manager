import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, chmodSync, mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const PYTHON_BIN = '/usr/bin/python3'
let tempDir: string | null = null

function getSandbox(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'bundle-consumer-'))
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

const CONSUMER_IMPORT = `
import os, stat, scripts.web_only_bundle_consumer as c
open_bundle = c.open_validated_bundle_fd
`

describe('web-only-bundle-consumer U2.1a inert traversal and FD ownership', () => {
  it.each([
    ['relative path', () => 'rel/bundle', 'ValueError'],
    ['non-canonical trailing slash', (dir: string) => join(dir, 'b') + '/', 'ValueError'],
    ['non-canonical dot segment', (dir: string) => dir + '/../bundle', 'ValueError'],
    ['empty path', () => '', 'ValueError'],
    ['symlink ancestor', (dir: string) => {
      const r = join(dir, 'r'); const s = join(dir, 's'); mkdirSync(r); symlinkSync(r, s); return join(s, 'b')
    }, 'PermissionError'],
    ['symlink bundle', (dir: string) => {
      const b = join(dir, 'real'); const s = join(dir, 'sym'); mkdirSync(b, 0o700); symlinkSync(b, s); return s
    }, 'PermissionError'],
    ['bad bundle mode 0777', (dir: string) => {
      const b = join(dir, 'b7'); mkdirSync(b); chmodSync(b, 0o777); return b
    }, 'PermissionError'],
  ])('rejects insecure filesystem invariants: %s', (_, setupPath, errType) => {
    const sb = getSandbox()
    const target = setupPath(sb)
    expectPython(`${CONSUMER_IMPORT}
try:
    open_bundle("${target}")
    print("FAILED")
except ${errType}:
    print("REJECTED_FS")`, 'REJECTED_FS')
  })

  it('rejects untrusted ancestor owner or insecure permissions', () => {
    const sb = getSandbox()
    const bdir = join(sb, 'bundle')
    mkdirSync(bdir, 0o700)
    expectPython(`${CONSUMER_IMPORT}
orig_fstat = os.fstat
def mock_fstat(fd):
    st = orig_fstat(fd)
    class FakeStat:
        def __getattr__(self, name):
            if name == "st_uid": return 99999
            return getattr(st, name)
    return FakeStat()
os.fstat = mock_fstat
try:
    open_bundle("${bdir}")
    print("FAILED")
except PermissionError:
    print("REJECTED_UNTRUSTED")
finally:
    os.fstat = orig_fstat`, 'REJECTED_UNTRUSTED')
  })

  it('successfully opens validated 0700 bundle, returns owned fd, and caller closes', () => {
    const sb = getSandbox()
    const bdir = join(sb, 'bundle')
    mkdirSync(bdir, 0o700)
    expectPython(`${CONSUMER_IMPORT}
fd = open_bundle("${bdir}")
assert isinstance(fd, int) and fd >= 0
st = os.fstat(fd)
assert stat.S_ISDIR(st.st_mode) and (st.st_mode & 0o777) == 0o700 and st.st_uid == os.geteuid()
os.close(fd)
print("SUCCESS_OWNED_FD")`, 'SUCCESS_OWNED_FD')
  })

  it('supports caller managing descriptor with FDOwnershipRegistry', () => {
    const sb = getSandbox()
    const bdir = join(sb, 'bundle')
    mkdirSync(bdir, 0o700)
    expectPython(`
from scripts.web_only_bundle_consumer import open_validated_bundle_fd, FDOwnershipRegistry
reg = FDOwnershipRegistry()
fd = reg.register(open_validated_bundle_fd("${bdir}"))
assert len(reg) == 1
reg.close(fd)
assert len(reg) == 0
print("REGISTRY_OWNERSHIP_SUCCESS")`, 'REGISTRY_OWNERSHIP_SUCCESS')
  })

  it('rejects post-open fstat mismatch fail-closed without leaking descriptors', () => {
    const sb = getSandbox()
    const bdir = join(sb, 'bundle')
    mkdirSync(bdir, 0o700)
    expectPython(`${CONSUMER_IMPORT}
orig_fstat = os.fstat
def mock_fstat(fd):
    st = orig_fstat(fd)
    if stat.S_ISDIR(st.st_mode) and (st.st_mode & 0o777) == 0o700:
        class TamperedStat:
            def __getattr__(self, name):
                if name == "st_mode": return (st.st_mode & ~0o777) | 0o755
                return getattr(st, name)
        return TamperedStat()
    return st
os.fstat = mock_fstat
try:
    open_bundle("${bdir}")
    print("FAILED")
except PermissionError:
    print("POST_OPEN_REJECTED")
finally:
    os.fstat = orig_fstat`, 'POST_OPEN_REJECTED')
  })

  it.each([
    ['ancestor transition', 1, 'OSError', 'OSError("transition close error")'],
    ['ancestor transition', 1, 'KeyboardInterrupt', 'KeyboardInterrupt("transition interrupt")'],
    ['ancestor transition', 1, 'SystemExit', 'SystemExit(42)'],
    ['final parent close', 3, 'OSError', 'OSError("parent close error")'],
    ['final parent close', 3, 'KeyboardInterrupt', 'KeyboardInterrupt("parent interrupt")'],
    ['final parent close', 3, 'SystemExit', 'SystemExit(42)'],
  ])('prevents fd retry and protects sentinel reuse on %s %s', (_, failCall, _name, excExpr) => {
    const sb = getSandbox()
    const bdir = join(sb, 'bundle')
    mkdirSync(bdir, 0o700)
    expectPython(`${CONSUMER_IMPORT}
orig_close = os.close
close_calls, reused_sentinel = [], None
primary_exc = ${excExpr}
def mock_close(fd):
    global reused_sentinel
    close_calls.append(fd)
    if len(close_calls) == ${failCall}:
        orig_close(fd)
        reused_sentinel = os.open("/dev/null", os.O_RDONLY)
        raise primary_exc
    return orig_close(fd)
os.close = mock_close
try:
    open_bundle("${bdir}")
    print("FAILED")
except BaseException as caught:
    assert caught is primary_exc, "primary exception identity lost"
    assert reused_sentinel is not None
    try:
        os.fstat(reused_sentinel)
        print("SENTINEL_PROTECTED")
    except OSError:
        print("SENTINEL_CLOSED")
finally:
    os.close = orig_close
    if reused_sentinel is not None:
        try: os.close(reused_sentinel)
        except OSError: pass`, 'SENTINEL_PROTECTED')
  })

  it('preserves primary error when secondary error occurs during cleanup', () => {
    const sb = getSandbox()
    const bdir = join(sb, 'b7')
    mkdirSync(bdir, 0o777)
    expectPython(`${CONSUMER_IMPORT}
orig_close = os.close
calls = 0
def mock_close(fd):
    global calls
    calls += 1
    if calls == 3:
        raise KeyboardInterrupt("secondary interrupt during cleanup")
    return orig_close(fd)
os.close = mock_close
try:
    open_bundle("${bdir}")
    print("FAILED")
except PermissionError:
    print("PRIMARY_PRESERVED")
except BaseException as e:
    print(f"WRONG_ERROR_{type(e).__name__}")
finally:
    os.close = orig_close`, 'PRIMARY_PRESERVED')
  })

  it('leaves zero descriptor leak on successful open and caller close, and on error', () => {
    const sb = getSandbox()
    const bdir = join(sb, 'bundle')
    mkdirSync(bdir, 0o700)
    expectPython(`${CONSUMER_IMPORT}
fds_before = set(os.listdir("/proc/self/fd"))
fd = open_bundle("${bdir}")
fds_during = set(os.listdir("/proc/self/fd")) - fds_before
assert len(fds_during) == 1 and str(fd) in fds_during
os.close(fd)
assert set(os.listdir("/proc/self/fd")) == fds_before

try:
    open_bundle("${bdir}/nonexistent")
except (FileNotFoundError, OSError):
    pass
assert set(os.listdir("/proc/self/fd")) == fds_before
print("ZERO_FD_LEAK")`, 'ZERO_FD_LEAK')
  })

  it.each([
    ['cleanup success', 'None'],
    ['cleanup OSError', 'OSError("cleanup error")'],
    ['cleanup KeyboardInterrupt', 'KeyboardInterrupt("cleanup interrupt")'],
    ['cleanup SystemExit', 'SystemExit(42)'],
  ])('prevents bundle fd retry and protects sentinel reuse on final parent close error: %s', (_, secExpr) => {
    const sb = getSandbox()
    const bdir = join(sb, 'bundle')
    mkdirSync(bdir, 0o700)
    expectPython(`${CONSUMER_IMPORT}
orig_open, orig_close = os.open, os.close
bundle_fd, sentinel_fd, dummy_fd = None, None, None
parent_closed, bundle_closes = False, 0
primary_exc = OSError("parent close failure")
sec_exc = ${secExpr}
fds_before = set(os.listdir("/proc/self/fd"))
def mock_open(path, *args, **kwargs):
    global bundle_fd
    fd = orig_open(path, *args, **kwargs)
    if path == "bundle": bundle_fd = fd
    return fd
def mock_close(fd):
    global sentinel_fd, parent_closed, dummy_fd, bundle_closes
    if bundle_fd is not None:
        if fd == bundle_fd:
            bundle_closes += 1
            if bundle_closes == 1:
                orig_close(fd)
                sentinel_fd = orig_open("/dev/null", os.O_RDONLY)
                if sec_exc is not None: raise sec_exc
                return
            return orig_close(fd)
        elif not parent_closed:
            parent_closed = True
            orig_close(fd)
            dummy_fd = orig_open("/dev/null", os.O_RDONLY)
            raise primary_exc
    return orig_close(fd)
os.open, os.close = mock_open, mock_close
try:
    open_bundle("${bdir}")
    print("FAILED")
except BaseException as caught:
    assert caught is primary_exc, "primary error identity lost"
    assert bundle_closes == 1, f"expected 1 bundle close, got {bundle_closes}"
    assert sentinel_fd == bundle_fd, "sentinel did not reuse bundle descriptor"
    os.fstat(sentinel_fd)
    if dummy_fd is not None: orig_close(dummy_fd)
    orig_close(sentinel_fd)
    assert set(os.listdir("/proc/self/fd")) == fds_before, "fd leak"
    print("PROTECTED")
finally:
    os.open, os.close = orig_open, orig_close`, 'PROTECTED')
  })
})
