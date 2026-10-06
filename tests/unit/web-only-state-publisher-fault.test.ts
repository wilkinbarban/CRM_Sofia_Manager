/**
 * Fault injection suite for web-only state publisher initial fstat verification.
 * Tests initial fstat failure scenarios: forged foreign UID and nonregular FIFO mode.
 * Verifies that empty temp is preserved (no payload write before validation), no blind unlink
 * is executed before identity verification, old release.env remains completely intact,
 * and descriptors are cleanly drained.
 *
 * Mocked UID and mode are validation contract evidence, not real foreign ownership reproduction.
 * Honest limits: stat+unlink and safe_unlink_devino are not atomic against same-UID concurrency (TOCTOU).
 */
import { describe, expect, it, afterEach } from 'vitest'
import { join } from 'node:path'
import { statSync, writeFileSync, readFileSync } from 'node:fs'
import { createPrivateSandbox, type PrivateSandbox } from '../helpers/web-private-sandbox'
import { createBundleFixture } from '../helpers/web-bundle-fixture'

let sb: PrivateSandbox | null = null

afterEach(() => {
  if (sb) {
    sb.cleanup()
    sb = null
  }
})

function setupDeploySandbox() {
  sb = createPrivateSandbox()
  const deployDir = sb.mkdir('deploy', 0o700)
  const fixture = createBundleFixture(sb)
  const existingFile = join(deployDir, 'release.env')
  writeFileSync(existingFile, 'OLD_RELEASE_BYTES\n', { mode: 0o644 })
  const origStat = statSync(existingFile)
  return { deployDir, fixture, existingFile, origStat }
}

function expectTargetUnchanged(existingFile: string, origStat: ReturnType<typeof statSync>) {
  const postStat = statSync(existingFile)
  expect(postStat.size).toBe(origStat.size)
  expect(postStat.mode).toBe(origStat.mode)
  expect(postStat.ino).toBe(origStat.ino)
  expect(postStat.dev).toBe(origStat.dev)
  expect(postStat.mtimeMs).toBe(origStat.mtimeMs)
  expect(readFileSync(existingFile, 'utf8')).toBe('OLD_RELEASE_BYTES\n')
}

const HARNESS_PY = `import sys, json, os, stat
import scripts.web_only_state as ws, scripts.web_only_state_publisher as wsp
_orig_fstat, _orig_unlink = os.fstat, os.unlink
def live_fds():
    res = set()
    for e in os.listdir("/proc/self/fd"):
        try:
            fd = int(e)
            _orig_fstat(fd)
            res.add(fd)
        except OSError: pass
    return res
data = json.loads(sys.argv[1])
st, args = data["st"], data["args"]
deploy_dir, fault_type = data["deployDir"], data["faultType"]
unlink_calls, fault_injected, captured_real_devino = [0], [0], [None]
def count_unlink(*a, **k):
    unlink_calls[0] += 1
    return _orig_unlink(*a, **k)
os.unlink = count_unlink
pre_inos = {os.stat(os.path.join(r, f)).st_ino for r, _, fs in os.walk(deploy_dir) for f in fs}
bdir = st.get("BUNDLE_DIR")
if bdir and os.path.isdir(bdir):
    pre_inos |= {os.stat(os.path.join(r, f)).st_ino for r, _, fs in os.walk(bdir) for f in fs}
def mock_fstat(fd):
    st_res = _orig_fstat(fd)
    if stat.S_ISREG(st_res.st_mode) and st_res.st_ino not in pre_inos and fault_injected[0] == 0:
        fault_injected[0] += 1
        captured_real_devino[0] = (st_res.st_dev, st_res.st_ino)
        if fault_type == "foreign_uid":
            return os.stat_result((st_res.st_mode, st_res.st_ino, st_res.st_dev, st_res.st_nlink, os.geteuid() + 99, st_res.st_gid, st_res.st_size, st_res.st_atime, st_res.st_mtime, st_res.st_ctime))
        elif fault_type == "fifo":
            return os.stat_result((stat.S_IFIFO | 0o600, st_res.st_ino, st_res.st_dev, st_res.st_nlink, st_res.st_uid, st_res.st_gid, st_res.st_size, st_res.st_atime, st_res.st_mtime, st_res.st_ctime))
    return st_res
fdb = live_fds()
os.fstat = mock_fstat
caught = None
try:
    wsp.publish_v2_release_state(deploy_dir, st, **args)
except PermissionError as e: caught = e
finally:
    os.fstat, os.unlink = _orig_fstat, _orig_unlink
assert caught is not None and "created temp file mode, owner, or type mismatch" in str(caught)
assert fault_injected[0] == 1 and unlink_calls[0] == 0 and live_fds() == fdb
tmp_files = [f for f in os.listdir(deploy_dir) if f.startswith(".release.env.tmp.")]
assert len(tmp_files) == 1
tmp_stat = os.stat(os.path.join(deploy_dir, tmp_files[0]))
assert (tmp_stat.st_dev, tmp_stat.st_ino) == captured_real_devino[0]
assert tmp_stat.st_size == 0 and tmp_stat.st_uid == os.geteuid() and (tmp_stat.st_mode & 0o777) == 0o600
print("FAULT_VERIFIED")
`

const FAULT_PRELUDE_PY = `import sys, json, os, stat
import scripts.web_only_state as ws, scripts.web_only_state_publisher as wsp
_orig_fstat, _orig_stat, _orig_fsync, _orig_close, _orig_unlink, _orig_replace, _orig_open = os.fstat, os.stat, os.fsync, os.close, os.unlink, os.replace, os.open
_orig_write_all = wsp.write_all
def live_fds():
    res = set()
    for e in os.listdir("/proc/self/fd"):
        try:
            fd = int(e); _orig_fstat(fd); res.add(fd)
        except OSError: pass
    return res
data = json.loads(sys.argv[1])
st, args, deploy_dir = data["st"], data["args"], data["deployDir"]
`

const HARNESS_G3_PY = `${FAULT_PRELUDE_PY}
pri_err = OSError("simulated primary precommit fsync failure")
fsync_calls, close_calls, unlink_calls = [0], [0], [0]
def mock_fsync(fd):
    fsync_calls[0] += 1; raise pri_err
def mock_close(fd):
    if fsync_calls[0] > 0:
        close_calls[0] += 1; _orig_close(fd)
        raise KeyboardInterrupt("simulated secondary cleanup close interrupt")
    return _orig_close(fd)
def mock_unlink(*a, **k):
    if fsync_calls[0] > 0:
        unlink_calls[0] += 1; raise OSError("simulated secondary cleanup unlink error")
    return _orig_unlink(*a, **k)
fdb = live_fds()
os.fsync, os.close, os.unlink = mock_fsync, mock_close, mock_unlink
caught = None
try: wsp.publish_v2_release_state(deploy_dir, st, **args)
except BaseException as e: caught = e
finally: os.fsync, os.close, os.unlink = _orig_fsync, _orig_close, _orig_unlink
assert caught is pri_err
assert fsync_calls[0] == 1 and close_calls[0] >= 2 and unlink_calls[0] == 1
assert live_fds() == fdb
tmp_files = [f for f in os.listdir(deploy_dir) if f.startswith(".release.env.tmp.")]
assert len(tmp_files) == 1
tmp_stat = os.stat(os.path.join(deploy_dir, tmp_files[0]))
assert tmp_stat.st_uid == os.geteuid() and (tmp_stat.st_mode & 0o777) == 0o600
print("G3_VERIFIED")
`

const HARNESS_G4_PY = `${FAULT_PRELUDE_PY}
foreign_bytes = b"FOREIGN_INODE_TAMPER_PAYLOAD\\n"
kept_fd, own_devino = [None], [None]
foreign_devino, replaced_name = [None], [None]
second_stat_calls, foreign_unlink_calls = [0], [0]
def mock_fsync(fd):
    st_temp = _orig_fstat(fd)
    own_devino[0] = (st_temp.st_dev, st_temp.st_ino)
    kept_fd[0] = os.dup(fd)
    return _orig_fsync(fd)
def mock_stat(path, *a, **k):
    name = path if isinstance(path, str) else ""
    if name.startswith(".release.env.tmp.") and second_stat_calls[0] == 0:
        second_stat_calls[0] += 1
        replaced_name[0] = name
        foreign_path = os.path.join(deploy_dir, ".foreign_donor.tmp")
        with open(foreign_path, "wb") as f: f.write(foreign_bytes)
        fst = _orig_stat(foreign_path)
        foreign_devino[0] = (fst.st_dev, fst.st_ino)
        _orig_replace(foreign_path, os.path.join(deploy_dir, name))
    return _orig_stat(path, *a, **k)
def mock_unlink(path, *a, **k):
    name = path if isinstance(path, str) else ""
    if replaced_name[0] and name == replaced_name[0]:
        foreign_unlink_calls[0] += 1
    return _orig_unlink(path, *a, **k)
fdb = live_fds()
os.fsync, os.stat, os.unlink = mock_fsync, mock_stat, mock_unlink
caught = None
try: wsp.publish_v2_release_state(deploy_dir, st, **args)
except PermissionError as e: caught = e
finally:
    os.fsync, os.stat, os.unlink = _orig_fsync, _orig_stat, _orig_unlink
    if kept_fd[0] is not None: _orig_close(kept_fd[0]); kept_fd[0] = None
assert caught is not None and "temp file identity tampered before replace" in str(caught)
assert second_stat_calls[0] == 1 and foreign_devino[0] != own_devino[0]
assert foreign_unlink_calls[0] == 0 and os.path.exists(os.path.join(deploy_dir, replaced_name[0]))
cur_st = _orig_stat(os.path.join(deploy_dir, replaced_name[0]))
assert (cur_st.st_dev, cur_st.st_ino) == foreign_devino[0]
with open(os.path.join(deploy_dir, replaced_name[0]), "rb") as f: assert f.read() == foreign_bytes
assert live_fds() == fdb
print("G4_VERIFIED")
`

const HARNESS_G5_PY = `${FAULT_PRELUDE_PY}
target_stat_calls, open_temp_calls, write_all_calls, replace_calls = [0], [0], [0], [0]
def mock_stat(path, *a, **k):
    name = path if isinstance(path, str) else ""
    if name == "release.env" or os.path.basename(name) == "release.env":
        st_real = _orig_stat(path, *a, **k)
        if target_stat_calls[0] == 0:
            target_stat_calls[0] += 1
            return os.stat_result((st_real.st_mode, st_real.st_ino, st_real.st_dev, st_real.st_nlink, os.geteuid() + 99, st_real.st_gid, st_real.st_size, st_real.st_atime, st_real.st_mtime, st_real.st_ctime))
    return _orig_stat(path, *a, **k)
def mock_open(path, *a, **k):
    name = path if isinstance(path, str) else ""
    if name.startswith(".release.env.tmp."): open_temp_calls[0] += 1
    return _orig_open(path, *a, **k)
def mock_write_all(*a, **k):
    write_all_calls[0] += 1; return _orig_write_all(*a, **k)
def mock_replace(*a, **k):
    replace_calls[0] += 1; return _orig_replace(*a, **k)
fdb = live_fds()
os.stat, os.open, os.replace = mock_stat, mock_open, mock_replace
wsp.write_all = mock_write_all
caught = None
try: wsp.publish_v2_release_state(deploy_dir, st, **args)
except PermissionError as e: caught = e
finally:
    os.stat, os.open, os.replace = _orig_stat, _orig_open, _orig_replace
    wsp.write_all = _orig_write_all
assert caught is not None and "target release.env type or owner mismatch" in str(caught)
assert target_stat_calls[0] == 1 and open_temp_calls[0] == 0 and write_all_calls[0] == 0 and replace_calls[0] == 0
assert len([f for f in os.listdir(deploy_dir) if f.startswith(".release.env.tmp.")]) == 0
assert live_fds() == fdb
print("G5_VERIFIED")
`

const HARNESS_G6_PY = `${FAULT_PRELUDE_PY}
first_fstat_calls, second_stat_calls, replace_calls = [0], [0], [0]
captured_own_devino = [None]
pre_inos = {os.stat(os.path.join(r, f)).st_ino for r, _, fs in os.walk(deploy_dir) for f in fs}
def mock_fstat(fd):
    st_res = _orig_fstat(fd)
    if stat.S_ISREG(st_res.st_mode) and st_res.st_ino not in pre_inos and first_fstat_calls[0] == 0:
        first_fstat_calls[0] += 1
        captured_own_devino[0] = (st_res.st_dev, st_res.st_ino)
    return st_res
def mock_stat(path, *a, **k):
    name = path if isinstance(path, str) else ""
    if name.startswith(".release.env.tmp.") and second_stat_calls[0] == 0:
        second_stat_calls[0] += 1
        st_real = _orig_stat(path, *a, **k)
        injected_mode = (st_real.st_mode & ~0o7777) | stat.S_IFREG | 0o2600
        return os.stat_result((injected_mode, st_real.st_ino, st_real.st_dev, st_real.st_nlink, st_real.st_uid, st_real.st_gid, st_real.st_size, st_real.st_atime, st_real.st_mtime, st_real.st_ctime))
    return _orig_stat(path, *a, **k)
def mock_replace(*a, **k):
    replace_calls[0] += 1; return _orig_replace(*a, **k)
fdb = live_fds()
os.fstat, os.stat, os.replace = mock_fstat, mock_stat, mock_replace
caught = None
try: wsp.publish_v2_release_state(deploy_dir, st, **args)
except PermissionError as e: caught = e
finally: os.fstat, os.stat, os.replace = _orig_fstat, _orig_stat, _orig_replace
assert caught is not None and "temp file identity tampered before replace" in str(caught)
assert first_fstat_calls[0] == 1 and captured_own_devino[0] is not None
assert second_stat_calls[0] == 1 and replace_calls[0] == 0
assert len([f for f in os.listdir(deploy_dir) if "tmp" in f]) == 0
assert live_fds() == fdb
print("G6_VERIFIED")
`

describe('web-only-state-publisher-fault initial fstat fault preserves empty temp and target', () => {
  it('forged foreign UID preserves empty temp descriptor, leaves target untouched, and drains FDs', () => {
    sb = createPrivateSandbox()
    const deployDir = sb.mkdir('deploy', 0o700)
    const fixture = createBundleFixture(sb)
    const existingFile = join(deployDir, 'release.env')
    writeFileSync(existingFile, 'OLD_RELEASE_BYTES\n', { mode: 0o644 })
    const origStat = statSync(existingFile)

    const payload = { st: fixture.state, args: fixture.expectedArgs, deployDir, faultType: 'foreign_uid' }
    const res = sb.runPython(HARNESS_PY, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim()).toBe('FAULT_VERIFIED')

    const postStat = statSync(existingFile)
    expect(postStat.size).toBe(origStat.size)
    expect(postStat.mode).toBe(origStat.mode)
    expect(postStat.ino).toBe(origStat.ino)
    expect(postStat.dev).toBe(origStat.dev)
    expect(postStat.mtimeMs).toBe(origStat.mtimeMs)
    expect(readFileSync(existingFile, 'utf8')).toBe('OLD_RELEASE_BYTES\n')
  })

  it('forged nonregular FIFO preserves empty temp descriptor, leaves target untouched, and drains FDs', () => {
    sb = createPrivateSandbox()
    const deployDir = sb.mkdir('deploy', 0o700)
    const fixture = createBundleFixture(sb)
    const existingFile = join(deployDir, 'release.env')
    writeFileSync(existingFile, 'OLD_RELEASE_BYTES\n', { mode: 0o644 })
    const origStat = statSync(existingFile)

    const payload = { st: fixture.state, args: fixture.expectedArgs, deployDir, faultType: 'fifo' }
    const res = sb.runPython(HARNESS_PY, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim()).toBe('FAULT_VERIFIED')

    const postStat = statSync(existingFile)
    expect(postStat.size).toBe(origStat.size)
    expect(postStat.mode).toBe(origStat.mode)
    expect(postStat.ino).toBe(origStat.ino)
    expect(postStat.dev).toBe(origStat.dev)
    expect(postStat.mtimeMs).toBe(origStat.mtimeMs)
    expect(readFileSync(existingFile, 'utf8')).toBe('OLD_RELEASE_BYTES\n')
  })

  it('G3 primary precommit failure preserves primary error against secondary cleanup BaseException, restores descriptors, and preserves target', () => {
    const { deployDir, fixture, existingFile, origStat } = setupDeploySandbox()
    const payload = { st: fixture.state, args: fixture.expectedArgs, deployDir }
    const res = sb!.runPython(HARNESS_G3_PY, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim()).toBe('G3_VERIFIED')
    expectTargetUnchanged(existingFile, origStat)
  })

  it('G4 foreign replacement before second stat is rejected, foreign inode preserved, target unchanged', () => {
    const { deployDir, fixture, existingFile, origStat } = setupDeploySandbox()
    const payload = { st: fixture.state, args: fixture.expectedArgs, deployDir }
    const res = sb!.runPython(HARNESS_G4_PY, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim()).toBe('G4_VERIFIED')
    expectTargetUnchanged(existingFile, origStat)
  })

  it('G5 foreign UID owner on existing target rejects before temp creation, zero write/replace, target preserved', () => {
    const { deployDir, fixture, existingFile, origStat } = setupDeploySandbox()
    const payload = { st: fixture.state, args: fixture.expectedArgs, deployDir }
    const res = sb!.runPython(HARNESS_G5_PY, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim()).toBe('G5_VERIFIED')
    expectTargetUnchanged(existingFile, origStat)
  })

  it('G6 second stat mode with special bits 02600 is rejected before replace, own temp unlinked, target preserved', () => {
    const { deployDir, fixture, existingFile, origStat } = setupDeploySandbox()
    const payload = { st: fixture.state, args: fixture.expectedArgs, deployDir }
    const res = sb!.runPython(HARNESS_G6_PY, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim()).toBe('G6_VERIFIED')
    expectTargetUnchanged(existingFile, origStat)
  })
})
