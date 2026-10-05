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

describe('web-only-bundle-consumer U2.1b inert read_private_entry and parse_json_safe', () => {
  it.each([
    ['negative bundle_fd', '-1', '"manifest.json"'],
    ['boolean bundle_fd', 'True', '"manifest.json"'],
    ['unauthorized name', 'bfd', '"other.json"'],
    ['path traversal name', 'bfd', '"../manifest.json"'],
    ['absolute path name', 'bfd', '"/manifest.json"'],
    ['slash separator name', 'bfd', '"sub/manifest.json"'],
  ])('rejects invalid bundle descriptor or entry name: %s', (_, bfdExpr, nameExpr) => {
    const sb = getSandbox()
    expectPython(`
import os, scripts.web_only_bundle_consumer as c
bfd = os.open("${sb}", os.O_RDONLY | os.O_DIRECTORY)
try:
    c.read_private_entry(${bfdExpr}, ${nameExpr})
    print("FAILED")
except ValueError:
    print("REJECTED_INPUT")
finally:
    os.close(bfd)`, 'REJECTED_INPUT')
  })

  it.each([
    ['symlink entry', (dir: string) => `with open("${dir}/real", "wb") as f: f.write(b"{}")\nos.chmod("${dir}/real", 0o600)\nos.symlink("${dir}/real", "${dir}/manifest.json")`],
    ['non-regular FIFO nohang', (dir: string) => `os.mkfifo("${dir}/manifest.json", 0o600)`],
    ['bad mode 0644', (dir: string) => `with open("${dir}/manifest.json", "wb") as f: f.write(b"{}")\nos.chmod("${dir}/manifest.json", 0o644)`],
    ['bad mode 0700', (dir: string) => `with open("${dir}/manifest.json", "wb") as f: f.write(b"{}")\nos.chmod("${dir}/manifest.json", 0o700)`],
  ])('rejects insecure filesystem entry invariant: %s', (_, setupFn) => {
    const sb = getSandbox()
    const setupPy = setupFn(sb)
    expectPython(`
import os, scripts.web_only_bundle_consumer as c
${setupPy}
bfd = os.open("${sb}", os.O_RDONLY | os.O_DIRECTORY)
try:
    c.read_private_entry(bfd, "manifest.json")
    print("FAILED")
except PermissionError:
    print("REJECTED_ENTRY")
finally:
    os.close(bfd)`, 'REJECTED_ENTRY')
  })

  it('rejects entry owner mismatch', () => {
    const sb = getSandbox()
    expectPython(`
import os, stat, scripts.web_only_bundle_consumer as c
mpath = os.path.join("${sb}", "manifest.json")
with open(mpath, "wb") as f: f.write(b"{}")
os.chmod(mpath, 0o600)
bfd = os.open("${sb}", os.O_RDONLY | os.O_DIRECTORY)
orig_fstat = os.fstat
def mock_fstat(fd):
    st = orig_fstat(fd)
    if stat.S_ISREG(st.st_mode):
        class MockStat:
            def __getattr__(self, name):
                if name == "st_uid": return 99999
                return getattr(st, name)
        return MockStat()
    return st
os.fstat = mock_fstat
try:
    c.read_private_entry(bfd, "manifest.json")
    print("FAILED")
except PermissionError:
    print("REJECTED_OWNER")
finally:
    os.fstat = orig_fstat
    os.close(bfd)`, 'REJECTED_OWNER')
  })

  it.each([
    ['manifest.json', '{"schema_version": "1.0"}'],
    ['candidate-compose.json', '{"services": {"web": {"image": "c"}}}'],
    ['rollback-compose.json', '{"services": {"web": {"image": "r"}}}'],
  ])('reads validated private entry for fixed names: %s', (name, payload) => {
    const sb = getSandbox()
    expectPython(`
import os, hashlib, scripts.web_only_bundle_consumer as c
p = os.path.join("${sb}", "${name}")
content = ${JSON.stringify(payload)}.encode("utf-8")
with open(p, "wb") as f: f.write(content)
os.chmod(p, 0o600)
bfd = os.open("${sb}", os.O_RDONLY | os.O_DIRECTORY)
data, digest = c.read_private_entry(bfd, "${name}")
assert data == content, "data mismatch"
assert digest == hashlib.sha256(content).hexdigest(), "digest mismatch"
st = os.fstat(bfd)
assert st is not None, "caller bundle_fd closed"
os.close(bfd)
print("SUCCESS_READ_ENTRY")`, 'SUCCESS_READ_ENTRY')
  })

  it('supports caller managing entry descriptor with FDOwnershipRegistry', () => {
    const sb = getSandbox()
    expectPython(`
import os, scripts.web_only_bundle_consumer as c
from scripts.web_only_bundle_consumer import FDOwnershipRegistry
p = os.path.join("${sb}", "manifest.json")
with open(p, "wb") as f: f.write(b"{}")
os.chmod(p, 0o600)
bfd = os.open("${sb}", os.O_RDONLY | os.O_DIRECTORY)
reg = FDOwnershipRegistry()
data, digest = c.read_private_entry(bfd, "manifest.json", registry=reg)
assert len(reg) == 0, "registry leaked descriptors"
os.close(bfd)
print("SUCCESS_REGISTRY_READ")`, 'SUCCESS_REGISTRY_READ')
  })

  it.each([
    ['registration failure', `    class FailingRegistry(c.FDOwnershipRegistry):
        def register(self, fd): raise RuntimeError("registration failed")
    reg = FailingRegistry()
    try:
        c.read_private_entry(bfd, "manifest.json", registry=reg)
        print("FAILED")
    except RuntimeError as err:
        assert str(err) == "registration failed"
        print("PRIMARY_PRESERVED")`],
    ['read failure', `    orig_read = os.read
    def mock_read(fd, n): raise OSError("read failed")
    os.read = mock_read
    try:
        c.read_private_entry(bfd, "manifest.json")
        print("FAILED")
    except OSError as err:
        assert str(err) == "read failed"
        print("PRIMARY_PRESERVED")
    finally:
        os.read = orig_read`],
    ['close failure with sentinel protection', `    orig_close = os.close
    reused_sentinel = None
    close_calls = 0
    def mock_close(fd):
        global reused_sentinel, close_calls
        if fd != bfd:
            close_calls += 1
            if close_calls == 1:
                orig_close(fd)
                reused_sentinel = os.open("/dev/null", os.O_RDONLY)
                raise OSError("close failed")
        return orig_close(fd)
    os.close = mock_close
    try:
        c.read_private_entry(bfd, "manifest.json")
        print("FAILED")
    except OSError as err:
        assert str(err) == "close failed"
        assert close_calls == 1, f"expected 1 close, got {close_calls}"
        assert reused_sentinel is not None
        os.fstat(reused_sentinel)
        print("PRIMARY_PRESERVED")
    finally:
        os.close = orig_close
        if reused_sentinel is not None:
            try: os.close(reused_sentinel)
            except OSError: pass`],
  ])('handles injected failure safely preserving primary and sentinel: %s', (_, testBody) => {
    const sb = getSandbox()
    expectPython(`
import os, scripts.web_only_bundle_consumer as c
p = os.path.join("${sb}", "manifest.json")
with open(p, "wb") as f: f.write(b"{}")
os.chmod(p, 0o600)
fds_before = set(os.listdir("/proc/self/fd"))
bfd = os.open("${sb}", os.O_RDONLY | os.O_DIRECTORY)
try:
${testBody}
finally:
    os.close(bfd)
assert set(os.listdir("/proc/self/fd")) == fds_before, "fd leaked"`, 'PRIMARY_PRESERVED')
  })

  it.each([
    ['non-bytes string', '"string"', 'ValueError', 'payload must be bytes'],
    ['non-bytes None', 'None', 'ValueError', 'payload must be bytes'],
    ['malformed UTF-8', 'b"\\xff\\xfe"', 'ValueError', 'malformed UTF-8'],
    ['empty bytes', 'b""', 'ValueError', 'syntax error'],
    ['incomplete syntax', 'b"{"', 'ValueError', 'syntax error'],
    ['syntax error', 'b"{bad}"', 'ValueError', 'syntax error'],
    ['non-object root array', 'b"[1, 2]"', 'ValueError', 'root must be a JSON object'],
    ['non-object root number', 'b"123"', 'ValueError', 'root must be a JSON object'],
    ['non-object root string', 'b"\\"hello\\""', 'ValueError', 'root must be a JSON object'],
    ['non-object root bool', 'b"true"', 'ValueError', 'root must be a JSON object'],
    ['non-object root null', 'b"null"', 'ValueError', 'root must be a JSON object'],
    ['NaN special float', 'b"{\\"val\\": NaN}"', 'ValueError', 'special numbers'],
    ['Infinity special float', 'b"{\\"val\\": Infinity}"', 'ValueError', 'special numbers'],
    ['-Infinity special float', 'b"{\\"val\\": -Infinity}"', 'ValueError', 'special numbers'],
    ['nested NaN in array', 'b"{\\"items\\": [NaN]}"', 'ValueError', 'special numbers'],
    ['positive float overflow', 'b"{\\"val\\": 1e999}"', 'ValueError', 'special numbers'],
    ['negative float overflow', 'b"{\\"val\\": -1e999}"', 'ValueError', 'special numbers'],
    ['nested float overflow', 'b"{\\"nested\\": {\\"val\\": 1e999}}"', 'ValueError', 'special numbers'],
    ['array float overflow', 'b"{\\"items\\": [1e999]}"', 'ValueError', 'special numbers'],
    ['duplicate keys root', 'b"{\\"a\\": 1, \\"a\\": 2}"', 'ValueError', 'duplicate key'],
    ['duplicate keys nested', 'b"{\\"nested\\": {\\"k\\": 1, \\"k\\": 2}}"', 'ValueError', 'duplicate key'],
    ['duplicate keys array', 'b"{\\"arr\\": [{\\"k\\": 1, \\"k\\": 2}]}"', 'ValueError', 'duplicate key'],
  ])('parse_json_safe rejects invalid payload: %s', (_, inputExpr, errType, expectedSubstr) => {
    expectPython(`
import scripts.web_only_bundle_consumer as c
try:
    c.parse_json_safe(${inputExpr})
    print("FAILED")
except ${errType} as err:
    assert "${expectedSubstr}" in str(err), f"unexpected error msg: {err}"
    print("REJECTED_JSON")`, 'REJECTED_JSON')
  })

  it('parse_json_safe generic error does not leak payload secrets', () => {
    expectPython(`
import scripts.web_only_bundle_consumer as c
secret = "SECRET_SUPER_TOKEN_xyz999"
for bad in [f'{{"{secret}": 1, "{secret}": 2}}'.encode(), f'{{"{secret}": '.encode()]:
    try:
        c.parse_json_safe(bad)
        print("FAILED")
    except ValueError as err:
        assert secret not in str(err), f"secret leaked in error: {err}"
print("SECRETS_PROTECTED")`, 'SECRETS_PROTECTED')
  })

  it('parse_json_safe successfully parses valid JSON payload with finite floats', () => {
    expectPython(`
import scripts.web_only_bundle_consumer as c
payload = b'{"schema_version": "1.0", "services": {"web": {"port": 80}}, "float_val": 1.25, "exp_val": 1e2, "tags": ["prod"]}'
parsed = c.parse_json_safe(payload)
assert parsed["schema_version"] == "1.0"
assert parsed["services"]["web"]["port"] == 80
assert parsed["float_val"] == 1.25
assert parsed["exp_val"] == 100.0
assert parsed["tags"] == ["prod"]
print("SUCCESS_PARSE_JSON")`, 'SUCCESS_PARSE_JSON')
  })
})
