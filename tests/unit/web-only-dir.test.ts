import { describe, expect, it, afterEach } from 'vitest'
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPrivateSandbox, type PrivateSandbox } from '../helpers/web-private-sandbox'

let sb: PrivateSandbox | null = null

afterEach(() => {
  if (sb) {
    sb.cleanup()
    sb = null
  }
})

function expectSuccess(script: string, payload?: unknown) {
  const options = payload !== undefined ? { args: [JSON.stringify(payload)] } : undefined
  const res = sb!.runPython(script, options)
  expect(res.status).toBe(0)
  expect(res.stdout.trim()).toBe('OK')
}

describe('web-only-dir U2.3a-ii.3 anchored traversal and descriptor ownership', () => {
  it('exports open_state_dir and open_state_root alias and enforces capabilities', () => {
    sb = createPrivateSandbox()
    const script = `
import os, scripts.web_only_dir as wd
assert wd.__all__ == ["open_state_dir", "open_state_root"]
assert callable(wd.open_state_dir)
assert wd.open_state_dir is wd.open_state_root

# Verify platform capability checks, restoring attributes between checks
for cap in ["O_NOFOLLOW", "O_DIRECTORY"]:
    orig = getattr(os, cap)
    try:
        delattr(os, cap)
        try:
            wd.open_state_dir("/tmp")
            assert False, f"should fail without {cap}"
        except RuntimeError as e:
            assert cap in str(e) or "capabilities" in str(e)
    finally:
        setattr(os, cap, orig)
print("OK")
`
    expectSuccess(script)
  })

  it('rejects empty, relative, root, and non-canonical paths with ValueError', () => {
    sb = createPrivateSandbox()
    const valid = sb.mkdir('valid')
    const badPaths = ['', 'relative/path', '/', valid + '/', valid + '/../escape', '//' + valid.slice(1)]
    const script = `
import sys, json, scripts.web_only_dir as wd
for p in json.loads(sys.argv[1]):
    try:
        wd.open_state_dir(p)
        assert False, f"expected ValueError for {p}"
    except ValueError:
        pass
print("OK")
`
    expectSuccess(script, badPaths)
  })

  it('rejects intermediate and final symlinks fail-closed', () => {
    sb = createPrivateSandbox()
    const realSub = sb.mkdir('realsub')
    const symSub = join(sb.dir, 'symsub')
    symlinkSync(realSub, symSub)
    const targetWithInterSymlink = join(symSub, 'leaf')

    const realLeaf = sb.mkdir('realleaf')
    const symLeaf = join(sb.dir, 'symleaf')
    symlinkSync(realLeaf, symLeaf)

    const script = `
import sys, json, scripts.web_only_dir as wd
data = json.loads(sys.argv[1])
for key in ["inter", "final"]:
    try:
        wd.open_state_dir(data[key])
        assert False, f"expected failure for {key}"
    except PermissionError as e:
        assert "symlink" in str(e)
print("OK")
`
    expectSuccess(script, { inter: targetWithInterSymlink, final: symLeaf })
  })

  it('rejects nonexistent paths and regular files at intermediate and final positions', () => {
    sb = createPrivateSandbox()
    const missing = join(sb.dir, 'missing-dir')
    const fileInter = join(sb.dir, 'inter-file')
    writeFileSync(fileInter, 'data')
    const fileFinal = join(sb.dir, 'final-file')
    writeFileSync(fileFinal, 'data')

    const script = `
import sys, json, scripts.web_only_dir as wd
data = json.loads(sys.argv[1])
try:
    wd.open_state_dir(data["missing"])
    assert False, "expected FileNotFoundError for missing"
except FileNotFoundError:
    pass
for k in ["under_file", "final_file"]:
    try:
        wd.open_state_dir(data[k])
        assert False, f"expected not-a-directory for {k}"
    except (NotADirectoryError, OSError):
        pass
print("OK")
`
    expectSuccess(script, { missing, under_file: join(fileInter, 'child'), final_file: fileFinal })
  })

  it('enforces exact 0700 mode and current euid on terminal state directory', () => {
    sb = createPrivateSandbox()
    const mode755 = sb.mkdir('mode755', 0o755)
    chmodSync(mode755, 0o755)
    const mode700 = sb.mkdir('mode700', 0o700)
    chmodSync(mode700, 0o700)

    const script = `
import sys, json, os, scripts.web_only_dir as wd
data = json.loads(sys.argv[1])
try:
    wd.open_state_dir(data["mode755"])
    assert False, "expected failure for mode 0755"
except PermissionError as e:
    assert "state directory owner or mode mismatch" in str(e)
    assert "mode755" in str(e)

orig_fstat = os.fstat
terminal_owner_hits = 0
term_stat = os.stat(data["mode700"])
term_devino = (term_stat.st_dev, term_stat.st_ino)

def mock_fstat(fd):
    global terminal_owner_hits
    st = orig_fstat(fd)
    if (st.st_dev, st.st_ino) == term_devino:
        terminal_owner_hits += 1
        return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, os.geteuid() + 99, st.st_gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime))
    return st

os.fstat = mock_fstat
try:
    wd.open_state_dir(data["mode700"])
    assert False, "expected failure for foreign terminal owner"
except PermissionError as e:
    assert "state directory owner or mode mismatch" in str(e)
    assert "mode700" in str(e)
finally:
    os.fstat = orig_fstat

assert terminal_owner_hits == 1, f"expected terminal owner hook once, got {terminal_owner_hits}"
print("OK")
`
    expectSuccess(script, { mode755, mode700 })
  })

  it('validates ancestor trusted owner, rejects writable without sticky bit, and allows sticky uid0', () => {
    sb = createPrivateSandbox()
    const ancestor = sb.mkdir('ancestor-dir', 0o700)
    const target = sb.mkdir('ancestor-dir/leaf-target', 0o700)
    const script = `
import sys, json, os, stat, scripts.web_only_dir as wd
data = json.loads(sys.argv[1])
ancestor_stat = os.stat(data["ancestor"])
ancestor_devino = (ancestor_stat.st_dev, ancestor_stat.st_ino)
root_stat = os.stat("/")
root_devino = (root_stat.st_dev, root_stat.st_ino)

orig_fstat = os.fstat
ancestor_cases = [
    ("untrusted ancestor owner", lambda st: os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, os.geteuid() + 99, st.st_gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime)), True),
    ("ancestor directory writable without sticky bit", lambda st: os.stat_result((stat.S_IFDIR | 0o777, st.st_ino, st.st_dev, st.st_nlink, 0, st.st_gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime)), True),
    ("sticky uid0 accepted", lambda st: os.stat_result((stat.S_IFDIR | stat.S_ISVTX | 0o777, st.st_ino, st.st_dev, st.st_nlink, 0, st.st_gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime)), False),
]

for expect_msg, mutator, should_fail in ancestor_cases:
    root_calls, ancestor_hits = 0, 0
    def mock_fstat(fd):
        global root_calls, ancestor_hits
        st = orig_fstat(fd)
        if (st.st_dev, st.st_ino) == root_devino:
            root_calls += 1
        elif (st.st_dev, st.st_ino) == ancestor_devino:
            ancestor_hits += 1
            return mutator(st)
        return st

    os.fstat = mock_fstat
    try:
        if should_fail:
            try:
                wd.open_state_dir(data["target"])
                assert False, f"expected failure for {expect_msg}"
            except PermissionError as e:
                assert expect_msg in str(e)
                assert "ancestor-dir" in str(e)
        else:
            fd = wd.open_state_dir(data["target"])
            assert fd >= 0
            os.close(fd)
    finally:
        os.fstat = orig_fstat

    assert root_calls == 1, f"expected root checked once, got {root_calls}"
    assert ancestor_hits == 1, f"expected ancestor hook once, got {ancestor_hits}"

print("OK")
`
    expectSuccess(script, { ancestor, target })
  })

  it('detects dev and ino identity changes between stat and open fstat', () => {
    sb = createPrivateSandbox()
    const target = sb.mkdir('devino-target')
    const script = `
import sys, json, os, scripts.web_only_dir as wd
target = json.loads(sys.argv[1])
orig_stat = os.stat

# Inode mismatch test and device-only mismatch test
checks = [
    ("inode", 12345, 0),
    ("device-only", 0, 1),
]
for desc, mod_ino, mod_dev in checks:
    def mock_stat(path, *args, **kwargs):
        st = orig_stat(path, *args, **kwargs)
        if os.path.basename(path) == 'devino-target' or path == 'devino-target':
            return os.stat_result((st.st_mode, st.st_ino + mod_ino, st.st_dev + mod_dev, st.st_nlink, st.st_uid, st.st_gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime))
        return st
    os.stat = mock_stat
    try:
        wd.open_state_dir(target)
        assert False, f"expected failure for {desc} change"
    except PermissionError as e:
        assert "identity mismatch" in str(e)
        assert "devino-target" in str(e)
    finally:
        os.stat = orig_stat

print("OK")
`
    expectSuccess(script, target)
  })

  it('guarantees zero FD leak on success (caller closes) and across all failures', () => {
    sb = createPrivateSandbox()
    const target = sb.mkdir('fd-target')
    const script = `
import sys, json, os, scripts.web_only_dir as wd
target = json.loads(sys.argv[1])

def live_fds():
    res = set()
    for e in os.listdir("/proc/self/fd"):
        try:
            fd = int(e)
            os.fstat(fd)
            res.add(fd)
        except OSError:
            pass
    return res

base_fds = live_fds()
fd = wd.open_state_dir(target)
assert fd >= 0
during_fds = live_fds() - base_fds
assert during_fds == {fd}
os.close(fd)
assert live_fds() == base_fds

for bad in ["/nonexistent", target + "/../escape", target + "/bad"]:
    try:
        wd.open_state_dir(bad)
    except Exception:
        pass
    assert live_fds() == base_fds
print("OK")
`
    expectSuccess(script, target)
  })

  it('preserves original error, protects foreign sentinel, and cleans descriptors on faults', () => {
    sb = createPrivateSandbox()
    const target = sb.mkdir('fault-target')
    const script = `
import sys, json, os, scripts.web_only_dir as wd
target = json.loads(sys.argv[1])

def live_fds():
    res = set()
    for e in os.listdir("/proc/self/fd"):
        try:
            fd = int(e)
            os.fstat(fd)
            res.add(fd)
        except OSError:
            pass
    return res

base_fds = live_fds()
orig_fstat = os.fstat

target_stat = os.stat(target)
target_devino = (target_stat.st_dev, target_stat.st_ino)
root_stat = os.stat("/")
root_devino = (root_stat.st_dev, root_stat.st_ino)

root_fstat_calls, target_fstat_faults = 0, 0

def fault_fstat(fd):
    global root_fstat_calls, target_fstat_faults
    st = orig_fstat(fd)
    if (st.st_dev, st.st_ino) == root_devino:
        root_fstat_calls += 1
        return st
    elif (st.st_dev, st.st_ino) == target_devino:
        target_fstat_faults += 1
        raise OSError("injected fstat fault")
    return st

os.fstat = fault_fstat
try:
    wd.open_state_dir(target)
    assert False, "expected fstat failure"
except OSError as e:
    assert str(e) == "injected fstat fault"
finally:
    os.fstat = orig_fstat

assert root_fstat_calls == 1, f"expected root fstat once, got {root_fstat_calls}"
assert target_fstat_faults == 1, f"expected target fstat fault once, got {target_fstat_faults}"
assert live_fds() == base_fds

orig_open = os.open
target_open_faults = 0

def fault_open(path, flags, *args, **kwargs):
    global target_open_faults
    if os.path.basename(path) == 'fault-target' or path == 'fault-target':
        target_open_faults += 1
        raise OSError("injected open fault")
    return orig_open(path, flags, *args, **kwargs)

os.open = fault_open
try:
    wd.open_state_dir(target)
    assert False, "expected open failure"
except OSError as e:
    assert str(e) == "injected open fault"
finally:
    os.open = orig_open

assert target_open_faults == 1, f"expected target open fault once, got {target_open_faults}"
assert live_fds() == base_fds

orig_close = os.close
close_calls, reused_sentinel = [], None
primary_exc = OSError("transition close error")

def mock_close(fd):
    global reused_sentinel
    close_calls.append(fd)
    if len(close_calls) == 1:
        orig_close(fd)
        reused_sentinel = orig_open("/dev/null", os.O_RDONLY)
        raise primary_exc
    return orig_close(fd)

os.close = mock_close
try:
    wd.open_state_dir(target)
    assert False, "expected transition error"
except OSError as caught:
    assert caught is primary_exc, "primary exception identity lost"
    assert reused_sentinel is not None
    orig_fstat(reused_sentinel)
finally:
    os.close = orig_close
    if reused_sentinel is not None:
        orig_close(reused_sentinel)

assert live_fds() == base_fds
print("OK")
`
    expectSuccess(script, target)
  })
})
