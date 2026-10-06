import { describe, expect, it, afterEach } from 'vitest'
import { chmodSync, writeFileSync } from 'node:fs'
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

describe('web-only-dir-fault U2.3a-ii.3A fault resilience and strict permissions', () => {
  it('opens valid directory via alias, transfers caller FD, and leaves no leak', () => {
    sb = createPrivateSandbox()
    const oddTarget = sb.mkdir('odd-target', 0o700)
    const evenTarget = sb.mkdir('odd-target/even-target', 0o700)
    const script = `
import sys, json, os, scripts.web_only_dir as wd
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
for target in json.loads(sys.argv[1]):
    for fn in (wd.open_state_dir, wd.open_state_root):
        base_fds = live_fds()
        fd = fn(target)
        assert fd >= 0 and fd not in base_fds
        os.fstat(fd)
        assert live_fds() - base_fds == {fd}
        os.close(fd)
        assert live_fds() == base_fds
        try:
            os.fstat(fd)
            assert False, "closed fd still valid"
        except OSError:
            pass
print("OK")
`
    expectSuccess(script, [oddTarget, evenTarget])
  })

  it('rejects terminal directories with special mode bits (04700, 02700, 01700)', () => {
    sb = createPrivateSandbox()
    const specialModes = [0o4700, 0o2700, 0o1700]
    const dirs: string[] = []
    for (const mode of specialModes) {
      const d = sb.mkdir(`special-${mode.toString(8)}`, 0o700)
      chmodSync(d, mode)
      dirs.push(d)
    }

    const script = `
import sys, json, scripts.web_only_dir as wd
for path in json.loads(sys.argv[1]):
    try:
        wd.open_state_dir(path)
        assert False, f"expected failure for special mode on {path}"
    except PermissionError:
        pass
print("OK")
`
    expectSuccess(script, dirs)
  })

  it('protects reused next_fd sentinel against double close on parent close error', () => {
    sb = createPrivateSandbox()
    const stateTarget = sb.mkdir('sub-target', 0o700)
    const sentinelFile = join(sb.dir, 'sentinel.dat')
    writeFileSync(sentinelFile, 'sentinel_payload_bytes_42')

    const script = `
import sys, json, os, scripts.web_only_dir as wd
data = json.loads(sys.argv[1])
target = data["target"]
sentinel_path = data["sentinel"]

expected_payload = b"sentinel_payload_bytes_42"
sentinel_stat = os.stat(sentinel_path)
base_fds = set(os.listdir("/proc/self/fd"))

orig_open = os.open
orig_close = os.close

target_next_fd = None
sentinel_fd = None
primary_err = OSError("simulated parent close failure")
next_close_count = 0

def mock_open(path, flags, *args, **kwargs):
    global target_next_fd
    fd = orig_open(path, flags, *args, **kwargs)
    if path == "sub-target":
        target_next_fd = fd
    return fd

def mock_close(fd):
    global sentinel_fd, next_close_count
    if target_next_fd is not None and fd == target_next_fd:
        next_close_count += 1
        if next_close_count == 1:
            orig_close(fd)
            # Reopen sentinel payload file immediately on lowest available descriptor
            s_fd = orig_open(sentinel_path, os.O_RDWR)
            if s_fd != target_next_fd:
                os.dup2(s_fd, target_next_fd)
                orig_close(s_fd)
                sentinel_fd = target_next_fd
            else:
                sentinel_fd = s_fd
            return
        elif next_close_count > 1:
            orig_close(fd)
            return
    elif target_next_fd is not None:
        orig_close(fd)
        raise primary_err
    return orig_close(fd)

os.open = mock_open
os.close = mock_close

try:
    wd.open_state_dir(target)
    assert False, "expected failure on parent close"
except BaseException as caught:
    assert caught is primary_err, f"expected exact primary error instance, got {type(caught)}"
    assert next_close_count == 1, f"expected NEXT to be closed exactly once, got {next_close_count}"
    assert sentinel_fd is not None, "sentinel was not opened"

    # Verify sentinel was not killed by double-close
    st = os.fstat(sentinel_fd)
    assert (st.st_dev, st.st_ino) == (sentinel_stat.st_dev, sentinel_stat.st_ino), "sentinel dev/ino mismatch"

    os.lseek(sentinel_fd, 0, os.SEEK_SET)
    content = os.read(sentinel_fd, 100)
    assert content == expected_payload, f"sentinel payload corrupted: {content}"
finally:
    os.open = orig_open
    os.close = orig_close
    if sentinel_fd is not None:
        try:
            orig_close(sentinel_fd)
        except OSError:
            pass

assert set(os.listdir("/proc/self/fd")) == base_fds, "descriptor leak detected"
print("OK")
`
    expectSuccess(script, { target: stateTarget, sentinel: sentinelFile })
  })
})
