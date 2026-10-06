import { describe, expect, it, afterEach } from 'vitest'
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

describe('web-only-dir-acceptance U2.3a-ii.3C root and intermediate traversal safety', () => {
  it('handles root fstat fault with primary identity, zero child calls, and FD cleanup', () => {
    sb = createPrivateSandbox()
    const target = sb.mkdir('root-fstat-target', 0o700)
    const script = `
import sys, json, os, scripts.web_only_dir as wd
target = json.loads(sys.argv[1])
orig_fstat, orig_stat, orig_open, orig_close = os.fstat, os.stat, os.open, os.close

def live_fds():
    res = set()
    for e in os.listdir("/proc/self/fd"):
        try:
            fd = int(e)
            orig_fstat(fd)
            res.add(fd)
        except OSError:
            pass
    return res

base_fds = live_fds()
root_stat = orig_stat("/")
root_devino = (root_stat.st_dev, root_stat.st_ino)
root_fstat_calls, child_stat_calls, child_open_calls = 0, 0, 0
closed_root_fds = []
primary_err = OSError("injected root fstat fault")

def mock_fstat(fd):
    global root_fstat_calls
    st = orig_fstat(fd)
    if (st.st_dev, st.st_ino) == root_devino:
        root_fstat_calls += 1
        raise primary_err
    return st

def mock_stat(path, *args, **kwargs):
    global child_stat_calls
    child_stat_calls += 1
    return orig_stat(path, *args, **kwargs)

def mock_open(path, flags, *args, **kwargs):
    global child_open_calls
    if path != "/":
        child_open_calls += 1
    return orig_open(path, flags, *args, **kwargs)

def mock_close(fd):
    st = orig_fstat(fd)
    if (st.st_dev, st.st_ino) == root_devino:
        closed_root_fds.append(fd)
    return orig_close(fd)

if hasattr(os, "supports_dir_fd"):
    os.supports_dir_fd.add(mock_open)
    os.supports_dir_fd.add(mock_stat)
    assert mock_open in os.supports_dir_fd and mock_stat in os.supports_dir_fd

os.fstat, os.stat, os.open, os.close = mock_fstat, mock_stat, mock_open, mock_close
caught_err = None
try:
    wd.open_state_dir(target)
except BaseException as e:
    caught_err = e
finally:
    os.fstat, os.stat, os.open, os.close = orig_fstat, orig_stat, orig_open, orig_close
    if hasattr(os, "supports_dir_fd"):
        os.supports_dir_fd.discard(mock_open)
        os.supports_dir_fd.discard(mock_stat)
        assert orig_open in os.supports_dir_fd and orig_stat in os.supports_dir_fd

assert caught_err is primary_err, f"expected exact primary error instance, got {type(caught_err)}"
assert root_fstat_calls == 1, f"expected root fstat called once, got {root_fstat_calls}"
assert child_stat_calls == 0, f"expected 0 child stat calls, got {child_stat_calls}"
assert child_open_calls == 0, f"expected 0 child open calls, got {child_open_calls}"
assert len(closed_root_fds) == 1, f"expected root fd closed once, got {len(closed_root_fds)}"
assert live_fds() == base_fds, "file descriptor leak detected"
print("OK")
`
    expectSuccess(script, target)
  })

  it('fails closed when root directory has untrusted owner or is writable without sticky bit', () => {
    sb = createPrivateSandbox()
    const target = sb.mkdir('root-owner-mode-target', 0o700)
    const script = `
import sys, json, os, stat, scripts.web_only_dir as wd
target = json.loads(sys.argv[1])
orig_fstat = os.fstat
root_stat = os.stat("/")
root_devino = (root_stat.st_dev, root_stat.st_ino)

def live_fds():
    res = set()
    for e in os.listdir("/proc/self/fd"):
        try:
            fd = int(e)
            orig_fstat(fd)
            res.add(fd)
        except OSError:
            pass
    return res

cases = [
    (
        "untrusted owner",
        "root directory untrusted owner",
        lambda st: os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, os.geteuid() + 99, st.st_gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime)),
    ),
    (
        "writable without sticky bit",
        "root directory is writable without sticky bit",
        lambda st: os.stat_result((stat.S_IFDIR | 0o777, st.st_ino, st.st_dev, st.st_nlink, 0, st.st_gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime)),
    ),
]

for label, expected_msg, mutator in cases:
    base_fds = live_fds()
    intercept_count = 0

    def mock_fstat(fd):
        global intercept_count
        st = orig_fstat(fd)
        if (st.st_dev, st.st_ino) == root_devino:
            intercept_count += 1
            return mutator(st)
        return st

    os.fstat = mock_fstat
    caught_err = None
    try:
        wd.open_state_dir(target)
    except PermissionError as e:
        caught_err = e
    finally:
        os.fstat = orig_fstat

    assert caught_err is not None, f"expected PermissionError for {label}"
    assert str(caught_err) == expected_msg, f"message mismatch for {label}: got {str(caught_err)}"
    assert intercept_count == 1, f"expected root fstat intercepted once for {label}, got {intercept_count}"
    assert live_fds() == base_fds, f"descriptor leak for {label}"

print("OK")
`
    expectSuccess(script, target)
  })

  it('fails closed on intermediate ancestor dev+ino mismatch and post-open non-directory type', () => {
    sb = createPrivateSandbox()
    const ancestor = sb.mkdir('inter-mismatch-ancestor', 0o700)
    const target = sb.mkdir('inter-mismatch-ancestor/leaf-target', 0o700)
    const script = `
import sys, json, os, stat, scripts.web_only_dir as wd
data = json.loads(sys.argv[1])
target = data["target"]
orig_fstat = os.fstat
ancestor_stat = os.stat(data["ancestor"])
ancestor_devino = (ancestor_stat.st_dev, ancestor_stat.st_ino)

def live_fds():
    res = set()
    for e in os.listdir("/proc/self/fd"):
        try:
            fd = int(e)
            orig_fstat(fd)
            res.add(fd)
        except OSError:
            pass
    return res

cases = [
    (
        "identity mismatch",
        f"path component identity mismatch after open: {os.path.basename(data['ancestor'])}",
        lambda st: os.stat_result((st.st_mode, st.st_ino + 9999, st.st_dev, st.st_nlink, st.st_uid, st.st_gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime)),
    ),
    (
        "type mismatch non-directory",
        f"path component type mismatch after open: {os.path.basename(data['ancestor'])}",
        lambda st: os.stat_result((stat.S_IFREG | 0o600, st.st_ino, st.st_dev, st.st_nlink, st.st_uid, st.st_gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime)),
    ),
]

for label, expected_msg, mutator in cases:
    base_fds = live_fds()
    ancestor_post_hits = 0

    def mock_fstat(fd):
        global ancestor_post_hits
        st = orig_fstat(fd)
        if (st.st_dev, st.st_ino) == ancestor_devino:
            ancestor_post_hits += 1
            return mutator(st)
        return st

    os.fstat = mock_fstat
    caught_err = None
    try:
        wd.open_state_dir(target)
    except PermissionError as e:
        caught_err = e
    finally:
        os.fstat = orig_fstat

    assert caught_err is not None, f"expected PermissionError for {label}"
    assert str(caught_err) == expected_msg, f"message mismatch for {label}: got {str(caught_err)}"
    assert ancestor_post_hits == 1, f"expected ancestor post-open fstat intercepted once for {label}, got {ancestor_post_hits}"
    assert live_fds() == base_fds, f"descriptor leak for {label}"

print("OK")
`
    expectSuccess(script, { ancestor, target })
  })

  it('cleans parent FD and preserves primary error on intermediate open failure or stat fault', () => {
    sb = createPrivateSandbox()
    const ancestor = sb.mkdir('parent-clean-ancestor', 0o700)
    const target = sb.mkdir('parent-clean-ancestor/leaf-target', 0o700)
    const script = `
import sys, json, os, scripts.web_only_dir as wd
data = json.loads(sys.argv[1])
target = data["target"]
orig_fstat, orig_stat, orig_open, orig_close = os.fstat, os.stat, os.open, os.close
ancestor_stat = orig_stat(data["ancestor"])
ancestor_devino = (ancestor_stat.st_dev, ancestor_stat.st_ino)

def live_fds():
    res = set()
    for e in os.listdir("/proc/self/fd"):
        try:
            fd = int(e)
            orig_fstat(fd)
            res.add(fd)
        except OSError:
            pass
    return res

fault_modes = ["open", "stat"]
for mode in fault_modes:
    base_fds = live_fds()
    fault_intercepts = 0
    primary_err = OSError(f"injected intermediate {mode} fault")
    parent_closed = []

    def mock_close(fd):
        try:
            st = orig_fstat(fd)
            if (st.st_dev, st.st_ino) == ancestor_devino:
                parent_closed.append(fd)
        except OSError:
            pass
        return orig_close(fd)

    def mock_open(path, flags, *args, **kwargs):
        global fault_intercepts
        if mode == "open":
            dir_fd = kwargs.get("dir_fd")
            if dir_fd is not None:
                st = orig_fstat(dir_fd)
                if (st.st_dev, st.st_ino) == ancestor_devino:
                    fault_intercepts += 1
                    raise primary_err
        return orig_open(path, flags, *args, **kwargs)

    def mock_stat(path, *args, **kwargs):
        global fault_intercepts
        if mode == "stat":
            dir_fd = kwargs.get("dir_fd")
            if dir_fd is not None:
                st = orig_fstat(dir_fd)
                if (st.st_dev, st.st_ino) == ancestor_devino:
                    fault_intercepts += 1
                    raise primary_err
        return orig_stat(path, *args, **kwargs)

    if hasattr(os, "supports_dir_fd"):
        os.supports_dir_fd.add(mock_open)
        os.supports_dir_fd.add(mock_stat)
        assert mock_open in os.supports_dir_fd
        assert mock_stat in os.supports_dir_fd

    os.open, os.stat, os.close = mock_open, mock_stat, mock_close
    caught_err = None
    try:
        wd.open_state_dir(target)
    except BaseException as e:
        caught_err = e
    finally:
        os.open, os.stat, os.close = orig_open, orig_stat, orig_close
        if hasattr(os, "supports_dir_fd"):
            os.supports_dir_fd.discard(mock_open)
            os.supports_dir_fd.discard(mock_stat)
            assert orig_open in os.supports_dir_fd
            assert orig_stat in os.supports_dir_fd

    assert caught_err is primary_err, f"expected exact primary {mode} error, got {type(caught_err)}"
    assert fault_intercepts == 1, f"expected {mode} fault intercepted once, got {fault_intercepts}"
    assert len(parent_closed) == 1, f"expected ancestor parent FD closed once for {mode}, got {len(parent_closed)}"
    assert live_fds() == base_fds, f"descriptor leak on intermediate {mode} fault"

print("OK")
`
    expectSuccess(script, { ancestor, target })
  })

  it('preserves primary error on root open failure with zero close calls', () => {
    sb = createPrivateSandbox()
    const target = sb.mkdir('root-open-target', 0o700)
    const script = `
import sys, json, os, scripts.web_only_dir as wd
target = json.loads(sys.argv[1])
orig_fstat, orig_open, orig_close = os.fstat, os.open, os.close

def live_fds():
    res = set()
    for e in os.listdir("/proc/self/fd"):
        try:
            fd = int(e)
            orig_fstat(fd)
            res.add(fd)
        except OSError:
            pass
    return res

base_fds = live_fds()
root_open_calls = 0
close_calls = []
primary_err = OSError("injected root open fault")

def mock_open(path, flags, *args, **kwargs):
    global root_open_calls
    if path == "/":
        root_open_calls += 1
        raise primary_err
    return orig_open(path, flags, *args, **kwargs)

def mock_close(fd):
    close_calls.append(fd)
    return orig_close(fd)

if hasattr(os, "supports_dir_fd"):
    os.supports_dir_fd.add(mock_open)
    assert mock_open in os.supports_dir_fd

os.open, os.close = mock_open, mock_close
caught_err = None
try:
    wd.open_state_dir(target)
except BaseException as e:
    caught_err = e
finally:
    os.open, os.close = orig_open, orig_close
    if hasattr(os, "supports_dir_fd"):
        os.supports_dir_fd.discard(mock_open)
        assert orig_open in os.supports_dir_fd

assert caught_err is primary_err, f"expected exact primary error instance, got {type(caught_err)}"
assert root_open_calls == 1, f"expected root open called once, got {root_open_calls}"
assert len(close_calls) == 0, f"expected zero close calls on root open failure, got {len(close_calls)}"
assert live_fds() == base_fds, "descriptor leak detected"
print("OK")
`
    expectSuccess(script, target)
  })
})
