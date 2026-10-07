import { describe, expect, it, afterEach } from 'vitest'
import { readdirSync } from 'node:fs'
import { createPrivateSandbox, type PrivateSandbox } from '../helpers/web-private-sandbox'
import { createBundleFixture, type BundleStateFixture } from '../helpers/web-bundle-fixture'

let sb: PrivateSandbox | null = null

afterEach(() => {
  if (sb) {
    sb.cleanup()
    sb = null
  }
})

function setupDeploy(sandbox: PrivateSandbox) {
  return { deployDir: sandbox.mkdir('deploy', 0o700), fixture: createBundleFixture(sandbox) }
}

function buildValidArgs(deployDir: string, fixture: BundleStateFixture, ep?: string): string[] {
  const args = [
    '--state-root', deployDir,
    '--bundle-dir', fixture.bundleDir,
    '--manifest-sha256', fixture.manifestSha256,
    '--previous-id', fixture.state.PREVIOUS_ID,
    '--deployed-id', fixture.state.DEPLOYED_ID,
    '--expected-root', fixture.expectedArgs.expected_root,
    '--expected-project', fixture.expectedArgs.expected_project,
    '--expected-networks', JSON.stringify(fixture.expectedArgs.expected_networks),
  ]
  if (ep) args.push('--expected-endpoint', ep)
  return args
}

describe('web-only-state-publisher CLI args payload helper', () => {
  it('defines _parse_cli_args helper and parses valid CLI argv into complete publication payload', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const validArgs = buildValidArgs(deployDir, fixture, fixture.expectedArgs.expected_endpoint)
    const harnessPy = `import sys, json
import scripts.web_only_state_publisher as wsp

assert hasattr(wsp, "_parse_cli_args"), "_parse_cli_args helper must exist in wsp"
assert callable(wsp._parse_cli_args), "_parse_cli_args must be callable"

data = json.loads(sys.argv[1])
f = data["fixture"]

# 1. Minimal valid args: optional refs and timestamp omitted
parsed_min = wsp._parse_cli_args(data["validArgs"])
assert isinstance(parsed_min, dict), "parsed result must be a dict"
assert parsed_min["state_root"] == data["deployDir"]
assert parsed_min["expected_root"] == f["expectedArgs"]["expected_root"]
assert parsed_min["expected_endpoint"] == f["expectedArgs"]["expected_endpoint"]
assert parsed_min["expected_project"] == f["expectedArgs"]["expected_project"]
assert parsed_min["expected_networks"] == f["expectedArgs"]["expected_networks"]

st_min = parsed_min["state"]
assert st_min["STATE_VERSION"] == "2"
assert st_min["DEPLOY_MODE"] == "web-only"
assert st_min["BUNDLE_DIR"] == f["bundleDir"]
assert st_min["MANIFEST_SHA256"] == f["manifestSha256"]
assert st_min["COMPOSE_PROJECT"] == f["expectedArgs"]["expected_project"]
assert st_min["OPERATIONAL_ROOT"] == f["expectedArgs"]["expected_root"]
assert st_min["DOCKER_ENDPOINT"] == f["expectedArgs"]["expected_endpoint"]
assert st_min["EXPECTED_NETWORKS"] == json.dumps(f["expectedArgs"]["expected_networks"])
assert st_min["PREVIOUS_ID"] == f["state"]["PREVIOUS_ID"]
assert st_min["DEPLOYED_ID"] == f["state"]["DEPLOYED_ID"]
assert "PREVIOUS_REF" not in st_min, "PREVIOUS_REF must only be present when supplied"
assert "DEPLOYED_REF" not in st_min, "DEPLOYED_REF must only be present when supplied"
assert "RECORDED_AT" not in st_min, "RECORDED_AT must only be present when supplied"

# 2. Complete valid args: optional refs and timestamp supplied
argv_full = data["validArgs"] + [
    "--previous-ref", "crm-web:v1",
    "--deployed-ref", "crm-web:v2",
    "--recorded-at", "2026-10-06T12:00:00Z",
]
parsed_full = wsp._parse_cli_args(argv_full)
st_full = parsed_full["state"]
assert st_full["PREVIOUS_REF"] == "crm-web:v1"
assert st_full["DEPLOYED_REF"] == "crm-web:v2"
assert st_full["RECORDED_AT"] == "2026-10-06T12:00:00Z"

print("PARSE_VALID_OK")`
    const payload = { validArgs, deployDir, fixture }
    const res = sb.runPython(harnessPy, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr.slice(0, 500)).toBe(0)
    expect(res.stdout.trim()).toBe('PARSE_VALID_OK')
  })

  it('strictly validates caller context and operational root, rejecting invalid paths and suppressing leakage', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const validArgs = buildValidArgs(deployDir, fixture, fixture.expectedArgs.expected_endpoint)
    const secretValue = 'super_secret_caller_context_token_9988'
    const harnessPy = `import sys, json
import scripts.web_only_state_publisher as wsp

data = json.loads(sys.argv[1])
base_args = data["validArgs"]
secret = data["secret"]

def replace_flag(args_list, flag, new_val):
    out = list(args_list)
    idx = out.index(flag)
    out[idx + 1] = new_val
    return out

def assert_invalid(args_list):
    try:
        wsp._parse_cli_args(args_list)
        raise AssertionError("invalid args must fail")
    except ValueError as err:
        assert str(err) == "ERR_INVALID_ARGS", f"expected ERR_INVALID_ARGS, got {err}"
        assert err.__cause__ is None, "error cause must be suppressed"
        assert err.__suppress_context__ is True, "error context must be suppressed"
        assert secret not in str(err), "secret must not leak in error message"

# 1. Non-existent expected_root (rejected by canonical _validate_caller_context)
assert_invalid(replace_flag(base_args, "--expected-root", f"/nonexistent/path/{secret}"))

# 2. Non-canonical expected_root with trailing slash
assert_invalid(replace_flag(base_args, "--expected-root", data["expected_root"] + "/"))

# 3. Invalid expected_project (blank / whitespace)
assert_invalid(replace_flag(base_args, "--expected-project", "   "))

print("VALIDATE_CALLER_CONTEXT_OK")`
    const payload = { validArgs, expected_root: fixture.expectedArgs.expected_root, secret: secretValue }
    const res = sb.runPython(harnessPy, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr.slice(0, 500)).toBe(0)
    expect(res.stdout.trim()).toBe('VALIDATE_CALLER_CONTEXT_OK')
    expect(res.stderr).not.toContain(secretValue)
  })

  it('strictly validates endpoints: expected required, no unix default, mismatch/docker-only reject, expected-only/match accept', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const baseNoEndpoint = buildValidArgs(deployDir, fixture)
    const harnessPy = `import sys, json
import scripts.web_only_state_publisher as wsp

data = json.loads(sys.argv[1])
base_no_ep = data["baseNoEndpoint"]
expected_ep = data["expectedEndpoint"]

def assert_invalid(args_list):
    try:
        wsp._parse_cli_args(args_list)
        raise AssertionError("invalid endpoint args must fail")
    except ValueError as err:
        assert str(err) == "ERR_INVALID_ARGS"
        assert err.__cause__ is None
        assert err.__suppress_context__ is True

# 1. Neither endpoint provided -> reject (neither defaults to unix socket)
assert_invalid(base_no_ep)

# 2. Only docker-endpoint provided -> reject
assert_invalid(base_no_ep + ["--docker-endpoint", expected_ep])

# 3. Explicit mismatch between expected and actual docker endpoint -> reject
assert_invalid(base_no_ep + [
    "--expected-endpoint", expected_ep,
    "--docker-endpoint", "unix:///var/run/custom-docker.sock",
])

# 4. Unsupported expected endpoint -> reject
assert_invalid(base_no_ep + ["--expected-endpoint", "tcp://127.0.0.1:2375"])

# 5. Only expected-endpoint provided -> accept
res_exp_only = wsp._parse_cli_args(base_no_ep + ["--expected-endpoint", expected_ep])
assert res_exp_only["expected_endpoint"] == expected_ep
assert res_exp_only["state"]["DOCKER_ENDPOINT"] == expected_ep

# 6. Both matching endpoints provided -> accept
res_both = wsp._parse_cli_args(base_no_ep + [
    "--expected-endpoint", expected_ep,
    "--docker-endpoint", expected_ep,
])
assert res_both["expected_endpoint"] == expected_ep
assert res_both["state"]["DOCKER_ENDPOINT"] == expected_ep

print("ENDPOINTS_VERIFIED_OK")`
    const payload = { baseNoEndpoint, expectedEndpoint: fixture.expectedArgs.expected_endpoint }
    const res = sb.runPython(harnessPy, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr.slice(0, 500)).toBe(0)
    expect(res.stdout.trim()).toBe('ENDPOINTS_VERIFIED_OK')
  })

  it('proves parser performs bounded validation with zero publication I/O via publisher spy and filesystem sentinel', () => {
    sb = createPrivateSandbox()
    const { deployDir, fixture } = setupDeploy(sb)
    const validArgs = buildValidArgs(deployDir, fixture, fixture.expectedArgs.expected_endpoint)
    const harnessPy = `import sys, json
import scripts.web_only_state_publisher as wsp

data = json.loads(sys.argv[1])
valid_args = data["validArgs"]
deploy_dir = data["deployDir"]

sentinel_calls = [0]
def sentinel_publisher(*a, **k):
    sentinel_calls[0] += 1
    raise RuntimeError("sentinel publisher must not be called")

orig_pub = wsp.publish_v2_release_state
wsp.publish_v2_release_state = sentinel_publisher
try:
    # 1. Invalid argv must fail without calling publisher
    try:
        wsp._parse_cli_args(["--state-root", deploy_dir])
        raise AssertionError("invalid args must fail")
    except ValueError as err:
        assert str(err) == "ERR_INVALID_ARGS"
    assert sentinel_calls[0] == 0, f"sentinel publisher was invoked {sentinel_calls[0]} times"

    # 2. Valid argv parses successfully without calling publisher
    parsed = wsp._parse_cli_args(valid_args)
    assert isinstance(parsed, dict)
    assert sentinel_calls[0] == 0, f"sentinel publisher was invoked {sentinel_calls[0]} times"
finally:
    wsp.publish_v2_release_state = orig_pub

print("NO_PUBLICATION_IO_OK")`
    const payload = { validArgs, deployDir }
    const res = sb.runPython(harnessPy, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr.slice(0, 500)).toBe(0)
    expect(res.stdout.trim()).toBe('NO_PUBLICATION_IO_OK')
    expect(readdirSync(deployDir).length).toBe(0)
  })

  it('uses typed ValueError and propagates control BaseExceptions without catching them', () => {
    sb = createPrivateSandbox()
    const harnessPy = `import sys
import scripts.web_only_state_publisher as wsp

# 1. Normal invalid argv raises typed ValueError("ERR_INVALID_ARGS")
try:
    wsp._parse_cli_args([])
    raise AssertionError("empty argv must fail")
except Exception as exc:
    assert isinstance(exc, ValueError), f"must be ValueError, got {type(exc)}"
    assert not isinstance(exc, (KeyboardInterrupt, SystemExit)), "must not be control BaseException"
    assert str(exc) == "ERR_INVALID_ARGS"

# 2. Control BaseException identity: KeyboardInterrupt and SystemExit propagate
for sentinel, check_code in [(KeyboardInterrupt("ki"), False), (SystemExit(99), True)]:
    orig_syntax = wsp._parse_cli_syntax
    hits = [0]
    def mock_err(*a, **k):
        hits[0] += 1
        raise sentinel
    wsp._parse_cli_syntax = mock_err
    try:
        try:
            wsp._parse_cli_args(["--state-root", "/tmp"])
            raise AssertionError("must propagate control exception")
        except BaseException as exc:
            assert hits[0] == 1, f"expected exactly 1 injection call, got {hits[0]}"
            assert exc is sentinel, f"must propagate exact identity, got {type(exc)}"
            if check_code:
                assert exc.code == 99, f"SystemExit code must be 99, got {exc.code}"
    finally:
        wsp._parse_cli_syntax = orig_syntax

print("CONTROL_EXCEPTIONS_OK")`
    const res = sb.runPython(harnessPy)
    expect(res.status, res.stderr.slice(0, 500)).toBe(0)
    expect(res.stdout.trim()).toBe('CONTROL_EXCEPTIONS_OK')
  })
})
