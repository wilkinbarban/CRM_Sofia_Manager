import { describe, expect, it, afterEach } from 'vitest'
import { join } from 'node:path'
import { statSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { createPrivateSandbox, type PrivateSandbox } from '../helpers/web-private-sandbox'
import { createBundleFixture, FIXTURE_CANDIDATE_IMAGE_ID, type BundleStateFixture } from '../helpers/web-bundle-fixture'

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

function expectPy(sandbox: PrivateSandbox, code: string, fixture?: BundleStateFixture, expected = '') {
  const args = fixture ? [JSON.stringify({ st: fixture.state, args: fixture.expectedArgs })] : []
  const res = sandbox.runPython(code, { args })
  expect(res.status, res.stderr).toBe(0)
  if (expected) expect(res.stdout.trim()).toBe(expected)
}

const INIT_PY = `import sys, json, os, stat
import scripts.web_only_state as ws, scripts.web_only_state_publisher as wsp
_orig_fstat = os.fstat
def live_fds():
    res = set()
    for e in os.listdir("/proc/self/fd"):
        try:
            fd = int(e)
            _orig_fstat(fd)
            res.add(fd)
        except OSError: pass
    return res
data = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
st, args = data.get("st", {}), data.get("args", {})
`

describe('web-only-state-publisher U2.3a serializer and atomic publisher', () => {
  it('verifies module and explicit APIs exist', () => {
    sb = createPrivateSandbox()
    expectPy(sb, `import scripts.web_only_state_publisher as wsp
assert callable(wsp.serialize_v2_release_env) and callable(wsp.publish_v2_release_state) and issubclass(wsp.PostCommitSyncError, RuntimeError)
print("API_EXISTS")`, undefined, 'API_EXISTS')
  })

  it('serializes deterministically and roundtrips with quotes and spaces', () => {
    sb = createPrivateSandbox()
    const fixture = createBundleFixture(sb)
    expectPy(sb, `${INIT_PY}
st["OPERATIONAL_ROOT"] = "${sb.dir}/space dir"
st["PREVIOUS_REF"], st["RECORDED_AT"] = "crm-web:v1", "2026-10-05T09:00:00Z"
raw = wsp.serialize_v2_release_env(st)
assert ws.parse_v2_release_env(raw) == st and "PREVIOUS_REF='crm-web:v1'" in raw and "OPERATIONAL_ROOT='${sb.dir}/space dir'" in raw
print("ROUNDTRIP_OK")`, fixture, 'ROUNDTRIP_OK')
  })

  it('rejects serialization of non-string values, invalid keys, and shell escapes', () => {
    sb = createPrivateSandbox()
    expectPy(sb, `import scripts.web_only_state_publisher as wsp
b = "x"*64
base = {"STATE_VERSION":"2","DEPLOY_MODE":"web-only","BUNDLE_DIR":"/b","MANIFEST_SHA256":b,"COMPOSE_PROJECT":"c","OPERATIONAL_ROOT":"/r","DOCKER_ENDPOINT":"unix:///var/run/docker.sock","EXPECTED_NETWORKS":'["n"]',"PREVIOUS_ID":"sha256:"+b,"DEPLOYED_ID":"sha256:"+b}
bad = [
    {**base, "STATE_VERSION": 2}, {**base, "DEPLOY_MODE": False}, {**base, "EXTRA": "val"},
    {k: v for k, v in base.items() if k != "DEPLOYED_ID"}, {**base, "BUNDLE_DIR": "/b$bad"},
    {**base, "DEPLOY_MODE": "web\\x60bad\\x60"}, {**base, "BUNDLE_DIR": "/b\\\\bad"}, {**base, "BUNDLE_DIR": "/b'bad"}, {**base, "RECORDED_AT": "2026-10-05\\n"},
]
for s in bad:
    try: wsp.serialize_v2_release_env(s); raise AssertionError("should have failed")
    except ValueError: pass
print("REJECT_SERIALIZE_OK")`, undefined, 'REJECT_SERIALIZE_OK')
  })

  it('publishes 0600 release.env readback validated with parse and consumer', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const existingFile = join(deployDir, 'release.env')
    writeFileSync(existingFile, 'OLD_TARGET_0644\n', { mode: 0o644 })
    expect(statSync(existingFile).mode & 0o777).toBe(0o644)
    expectPy(sb, `${INIT_PY}
rf, sc = os.fstat, [0]
pre_inos = {os.stat(os.path.join(r, f)).st_ino for r, _, fs in os.walk("${sb.dir}") for f in fs}
def mf(fd):
    st_res = rf(fd)
    if stat.S_ISREG(st_res.st_mode) and st_res.st_ino not in pre_inos and st_res.st_uid == os.geteuid() and (st_res.st_mode & 0o777) == 0o600:
        sc[0] += 1
        return os.stat_result((st_res.st_mode | 0o2000, st_res.st_ino, st_res.st_dev, st_res.st_nlink, st_res.st_uid, st_res.st_gid, st_res.st_size, st_res.st_atime, st_res.st_mtime, st_res.st_ctime))
    return st_res
os.fstat = mf
try:
    wsp.publish_v2_release_state("${deployDir}", st, **args)
    raise AssertionError("should have rejected special bits")
except PermissionError as e:
    assert sc[0] == 1 and "created temp file mode, owner, or type mismatch" in str(e)
finally: os.fstat = rf
assert len([f for f in os.listdir("${deployDir}") if "tmp" in f]) == 0 and open("${deployDir}/release.env").read() == "OLD_TARGET_0644\\n"
ret = wsp.publish_v2_release_state("${deployDir}", st, **args)
assert ret["status"] == "ok" and ret["committed"] is True and ret["durable"] is True
rf_content = ws.read_safe_state_file("${deployDir}/release.env")
assert ws.validate_v2_bundle_state(ws.parse_v2_release_env(rf_content), **args)["candidate_image_id"] == "${FIXTURE_CANDIDATE_IMAGE_ID}"
print("PUBLISH_READBACK_OK")`, fixture, 'PUBLISH_READBACK_OK')
    expect(statSync(existingFile).mode & 0o777).toBe(0o600)
  })

  it('rejects publication before filesystem I/O on bad state, SHA, or caller context', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    expectPy(sb, `${INIT_PY}
for s, root, nets in [({**st, "MANIFEST_SHA256": "0"*64}, "${sb.dir}", ["net_a"]), (st, "${sb.dir}/wrong", ["net_a"]), (st, "${sb.dir}", ["wrong_net"]), ({**st, "DEPLOYED_ID": "sha256:" + "0"*64}, "${sb.dir}", ["net_a"])]:
    try: wsp.publish_v2_release_state("${deployDir}", s, expected_root=root, expected_endpoint="unix:///var/run/docker.sock", expected_project="crm", expected_networks=nets); raise AssertionError("should have failed")
    except ValueError: pass
assert not os.path.exists("${deployDir}/release.env") and len(os.listdir("${deployDir}")) == 0
print("PREPUBLISH_REJECT_OK")`, fixture, 'PREPUBLISH_REJECT_OK')
  })

  it('preserves existing release.env bytes and mtime on failure and cleans own temp only', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const existingFile = join(deployDir, 'release.env')
    writeFileSync(existingFile, 'ORIGINAL_BYTES\n', { mode: 0o600 })
    const origStat = statSync(existingFile)
    expectPy(sb, `${INIT_PY}
unrelated = os.path.join("${deployDir}", "unrelated.txt")
with open(unrelated, "w") as f: f.write("keep")
rw = wsp.write_all
wsp.write_all = lambda *a: (_ for _ in ()).throw(OSError("simulated disk error"))
try: wsp.publish_v2_release_state("${deployDir}", st, **args)
except OSError: pass
finally: wsp.write_all = rw
assert open("${deployDir}/release.env").read() == "ORIGINAL_BYTES\\n" and open(unrelated).read() == "keep"
assert len([f for f in os.listdir("${deployDir}") if "tmp" in f]) == 0
print("PRESERVE_AND_CLEANUP_OK")`, fixture, 'PRESERVE_AND_CLEANUP_OK')
    expect(statSync(existingFile).mtimeMs).toBe(origStat.mtimeMs)
    expect(readFileSync(existingFile, 'utf8')).toBe('ORIGINAL_BYTES\n')
  })

  it('rejects symlinks, non-0700 modes, missing dirs, and FIFO targets without hang', () => {
    sb = createPrivateSandbox()
    const { fixture } = setupDeploy(sb)
    const sym = join(sb.dir, 'sym'), real = sb.mkdir('real', 0o700)
    symlinkSync(real, sym)
    const mode = sb.mkdir('mode', 0o755)
    const fifo = sb.mkdir('fifo', 0o700)
    const symT = sb.mkdir('symt', 0o700)
    symlinkSync(join(sb.dir, 't.env'), join(symT, 'release.env'))
    expectPy(sb, `${INIT_PY}
os.mkfifo(os.path.join("${fifo}", "release.env"), 0o600)
for path, err in [("${sym}", PermissionError), ("${mode}", PermissionError), ("${sb.dir}/missing", FileNotFoundError), ("${symT}", PermissionError), ("${fifo}", PermissionError)]:
    try: wsp.publish_v2_release_state(path, st, **args); raise AssertionError(f"expected {err} on {path}")
    except err: pass
print("REJECT_UNSAFE_TARGETS_OK")`, fixture, 'REJECT_UNSAFE_TARGETS_OK')
  })

  it('drains FDs and unlinks only own temp on BaseException/KeyboardInterrupt', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    expectPy(sb, `${INIT_PY}
ki = KeyboardInterrupt("simulated cancel")
real_sync, caught = os.fsync, None
fdb = live_fds()
os.fsync = lambda fd: (_ for _ in ()).throw(ki)
try:
    wsp.publish_v2_release_state("${deployDir}", st, **args)
    raise AssertionError("should have raised KeyboardInterrupt")
except KeyboardInterrupt as e: caught = e
finally: os.fsync = real_sync
assert caught is ki and len([f for f in os.listdir("${deployDir}") if "tmp" in f]) == 0
assert live_fds() == fdb
print("BASE_EXCEPTION_CLEANUP_OK")`, fixture, 'BASE_EXCEPTION_CLEANUP_OK')
  })

  it('reports PostCommitSyncError with committed=True when dir fsync fails after replace', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    expectPy(sb, `${INIT_PY}
rf, sc = os.fsync, [0]
def cf(fd):
    sc[0] += 1
    if sc[0] == 2: raise OSError("simulated EIO on dir fsync")
    return rf(fd)
os.fsync = cf
try: wsp.publish_v2_release_state("${deployDir}", st, **args); raise AssertionError("should have raised PostCommitSyncError")
except wsp.PostCommitSyncError as e: assert e.committed is True and os.path.exists("${deployDir}/release.env")
finally: os.fsync = rf
print("POST_COMMIT_SYNC_ERROR_OK")`, fixture, 'POST_COMMIT_SYNC_ERROR_OK')
  })

  it('distinguishes committed state with PostCommitSyncError when postcommit dir close fails with OSError', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    expectPy(sb, `${INIT_PY}
rep, rr, rc, att = [False], os.replace, os.close, []
def hr(*a, **k): rep[0] = True; return rr(*a, **k)
def hc(fd):
    if rep[0]: att.append(fd); rc(fd); raise OSError("simulated EIO on postcommit dir close")
    return rc(fd)
fdb = live_fds()
os.replace, os.close = hr, hc
try: wsp.publish_v2_release_state("${deployDir}", st, **args); raise AssertionError("should have raised PostCommitSyncError")
except wsp.PostCommitSyncError as e: assert e.committed is True and os.path.exists("${deployDir}/release.env") and isinstance(e.cause, OSError)
finally: os.replace, os.close = rr, rc
assert len(att) == 1 and live_fds() == fdb
print("POST_COMMIT_CLOSE_OSERROR_OK")`, fixture, 'POST_COMMIT_CLOSE_OSERROR_OK')
  })

  it('preserves postcommit primary fsync error against cleanup BaseException', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    expectPy(sb, `${INIT_PY}
rep, rr, rf, rc, att = [False], os.replace, os.fsync, os.close, []
pri_err = OSError("simulated fsync EIO")
def hr(*a, **k): rep[0] = True; return rr(*a, **k)
def hf(fd): return (_ for _ in ()).throw(pri_err) if rep[0] else rf(fd)
def hc(fd):
    if rep[0]: att.append(fd); rc(fd); raise KeyboardInterrupt("cleanup cancel")
    return rc(fd)
fdb = live_fds()
os.replace, os.fsync, os.close = hr, hf, hc
try: wsp.publish_v2_release_state("${deployDir}", st, **args); raise AssertionError("should have raised PostCommitSyncError")
except wsp.PostCommitSyncError as e: assert e.committed is True and e.cause is pri_err
finally: os.replace, os.fsync, os.close = rr, rf, rc
assert len(att) == 1 and live_fds() == fdb
print("PRESERVE_PRIMARY_AGAINST_BASE_EXCEPTION_OK")`, fixture, 'PRESERVE_PRIMARY_AGAINST_BASE_EXCEPTION_OK')
  })

  it('verifies exact FD drain counts before and after success, precommit, and postcommit failures', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    expectPy(sb, `${INIT_PY}
fdb = live_fds()
wsp.publish_v2_release_state("${deployDir}", st, **args)
assert live_fds() == fdb
rw = wsp.write_all
wsp.write_all = lambda *a: (_ for _ in ()).throw(OSError("precommit error"))
try: wsp.publish_v2_release_state("${deployDir}", st, **args)
except OSError: pass
finally: wsp.write_all = rw
assert live_fds() == fdb
rep, rr, rf, rc, ca = [False], os.replace, os.fsync, os.close, []
def hr(*a, **k): rep[0] = True; return rr(*a, **k)
def hf(fd): return (_ for _ in ()).throw(OSError("postcommit fsync error")) if rep[0] else rf(fd)
def hc(fd):
    if rep[0]: ca.append(fd); rc(fd); raise OSError("postcommit close error")
    return rc(fd)
os.replace, os.fsync = hr, hf
try: wsp.publish_v2_release_state("${deployDir}", st, **args)
except wsp.PostCommitSyncError: pass
finally: os.replace, os.fsync = rr, rf
assert live_fds() == fdb
rep[0] = False; os.replace, os.close = hr, hc
try: wsp.publish_v2_release_state("${deployDir}", st, **args)
except wsp.PostCommitSyncError: pass
finally: os.replace, os.close = rr, rc
assert len(ca) == 1 and live_fds() == fdb
print("FD_DRAIN_COUNTS_OK")`, fixture, 'FD_DRAIN_COUNTS_OK')
  })
})
