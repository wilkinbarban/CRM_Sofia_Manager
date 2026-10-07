import { describe, expect, it, afterEach } from 'vitest'
import { createPrivateSandbox, type PrivateSandbox } from '../helpers/web-private-sandbox'

let sb: PrivateSandbox | null = null

afterEach(() => {
  if (sb) {
    sb.cleanup()
    sb = null
  }
})

function buildValidArgs(deployDir: string): string[] {
  return [
    '--state-root', deployDir,
    '--bundle-dir', '/var/deploy/bundle',
    '--manifest-sha256', 'a'.repeat(64),
    '--previous-id', 'prev-container-id',
    '--deployed-id', 'curr-container-id',
    '--expected-root', '/var/deploy/op',
    '--expected-endpoint', 'unix:///var/run/docker.sock',
    '--expected-project', 'crm_web',
    '--expected-networks', '["net1", "net2"]',
  ]
}

describe('web-only-state-publisher CLI args syntax parser helper', () => {
  it('defines _parse_cli_syntax and parses valid CLI argv into syntactic flags dict without state assembly', () => {
    sb = createPrivateSandbox()
    const deployDir = sb.mkdir('deploy', 0o700)
    const validArgs = buildValidArgs(deployDir)
    const harnessPy = `import sys, json
import scripts.web_only_state_publisher as wsp

assert hasattr(wsp, "_parse_cli_syntax"), "_parse_cli_syntax helper must exist in wsp"
assert callable(wsp._parse_cli_syntax), "_parse_cli_syntax must be callable"

data = json.loads(sys.argv[1])
base_argv = data["validArgs"] + [
    "--previous-ref", "crm-web:v1",
    "--deployed-ref", "crm-web:v2",
    "--recorded-at", "2026-10-06T12:00:00Z",
]
cases = [
    (base_argv, None),
    (base_argv + ["--docker-endpoint", "unix:///var/run/custom.sock"], "unix:///var/run/custom.sock"),
]
for argv, expected_docker in cases:
    parsed = wsp._parse_cli_syntax(argv)
    assert isinstance(parsed, dict), "parsed result must be a dict"
    assert "state" not in parsed, "syntactic parser must not perform state assembly"
    assert parsed["state_root"] == data["deployDir"]
    assert parsed["bundle_dir"] == "/var/deploy/bundle"
    assert parsed["manifest_sha256"] == "a" * 64
    assert parsed["previous_id"] == "prev-container-id"
    assert parsed["deployed_id"] == "curr-container-id"
    assert parsed["expected_root"] == "/var/deploy/op"
    assert parsed["expected_endpoint"] == "unix:///var/run/docker.sock"
    assert parsed["expected_project"] == "crm_web"
    assert parsed["expected_networks"] == '["net1", "net2"]' or parsed["expected_networks"] == ["net1", "net2"]
    assert parsed["previous_ref"] == "crm-web:v1"
    assert parsed["deployed_ref"] == "crm-web:v2"
    assert parsed["recorded_at"] == "2026-10-06T12:00:00Z"
    assert parsed.get("docker_endpoint") == expected_docker

print("PARSE_SYNTAX_VALID_OK")`
    const payload = { validArgs, deployDir }
    const res = sb.runPython(harnessPy, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr.slice(0, 500)).toBe(0)
    expect(res.stdout.trim()).toBe('PARSE_SYNTAX_VALID_OK')
  })

  it('rejects missing required args, unknown flags, and suppresses secret/path leakage with fixed ERR_INVALID_ARGS', () => {
    sb = createPrivateSandbox()
    const deployDir = sb.mkdir('deploy', 0o700)
    const validArgs = buildValidArgs(deployDir)
    const secretValue = 'super_secret_diagnostic_token_12345'
    const harnessPy = `import sys, json
import scripts.web_only_state_publisher as wsp

data = json.loads(sys.argv[1])
secret = data["secret"]
deploy_dir = data["deployDir"]

# 1. Missing required args (only --bundle-dir)
try:
    wsp._parse_cli_syntax(["--bundle-dir", "/var/deploy/bundle"])
    raise AssertionError("missing required args must fail")
except ValueError as err:
    msg = str(err)
    assert msg == "ERR_INVALID_ARGS", f"expected ERR_INVALID_ARGS, got {msg}"

# 2. Unknown flag with secret value
try:
    wsp._parse_cli_syntax(data["validArgs"] + ["--bad-secret-flag", secret])
    raise AssertionError("unknown flag must fail")
except ValueError as err:
    msg = str(err)
    assert msg == "ERR_INVALID_ARGS", f"expected ERR_INVALID_ARGS, got {msg}"
    assert secret not in msg, "secret must not leak in error message"
    assert deploy_dir not in msg, "deploy dir must not leak in error message"

# 3. Blank or whitespace --docker-endpoint
for bad in ("", "   "):
    try:
        wsp._parse_cli_syntax(data["validArgs"] + ["--docker-endpoint", bad])
        raise AssertionError("blank docker-endpoint must fail")
    except ValueError as err:
        assert str(err) == "ERR_INVALID_ARGS"

print("REJECT_INVALID_ARGS_OK")`
    const payload = { validArgs, deployDir, secret: secretValue }
    const res = sb.runPython(harnessPy, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr.slice(0, 500)).toBe(0)
    expect(res.stdout.trim()).toBe('REJECT_INVALID_ARGS_OK')
    expect(res.stderr).not.toContain(secretValue)
    expect(res.stderr).not.toContain(deployDir)
  })

  it('strictly rejects abbreviations and duplicate flags across separate, inline, and mixed forms', () => {
    sb = createPrivateSandbox()
    const deployDir = sb.mkdir('deploy', 0o700)
    const validArgs = buildValidArgs(deployDir)
    const harnessPy = `import sys, json
import scripts.web_only_state_publisher as wsp

data = json.loads(sys.argv[1])
valid_args = data["validArgs"]
deploy_dir = data["deployDir"]

# Abbreviation rejection (e.g. --state instead of --state-root)
abbrev_args = [("--state" if a == "--state-root" else a) for a in valid_args]
try:
    wsp._parse_cli_syntax(abbrev_args)
    raise AssertionError("abbreviation --state must fail")
except ValueError as err:
    assert str(err) == "ERR_INVALID_ARGS"

# Separate duplicate flag: [...validArgs, '--state-root', deployDir]
try:
    wsp._parse_cli_syntax(valid_args + ["--state-root", deploy_dir])
    raise AssertionError("duplicate flag (separate) must fail")
except ValueError as err:
    assert str(err) == "ERR_INVALID_ARGS"

# Inline equals duplicate flag: [...validArgs, '--state-root=' + deployDir]
try:
    wsp._parse_cli_syntax(valid_args + [f"--state-root={deploy_dir}"])
    raise AssertionError("duplicate flag (inline) must fail")
except ValueError as err:
    assert str(err) == "ERR_INVALID_ARGS"

# Mixed duplicate flag prepended: ['--state-root=' + deployDir, ...validArgs]
try:
    wsp._parse_cli_syntax([f"--state-root={deploy_dir}"] + valid_args)
    raise AssertionError("duplicate flag (prepended) must fail")
except ValueError as err:
    assert str(err) == "ERR_INVALID_ARGS"

print("STRICT_FLAGS_OK")`
    const payload = { validArgs, deployDir }
    const res = sb.runPython(harnessPy, { args: [JSON.stringify(payload)] })
    expect(res.status, res.stderr.slice(0, 500)).toBe(0)
    expect(res.stdout.trim()).toBe('STRICT_FLAGS_OK')
  })

  it('parses expected networks safely and rejects non-string, boolean, blanks, duplicates, and malformed inputs', () => {
    sb = createPrivateSandbox()
    const secretNet = 'secret_private_lan_999'
    const harnessPy = `import sys
import scripts.web_only_state_publisher as wsp

assert hasattr(wsp, "_parse_cli_networks"), "_parse_cli_networks must exist"
assert callable(wsp._parse_cli_networks), "_parse_cli_networks must be callable"

secret = sys.argv[1]

# 1. Valid JSON list
assert wsp._parse_cli_networks('["net1", "net2"]') == ["net1", "net2"]

# 2. Valid CSV string
assert wsp._parse_cli_networks("net1, net2") == ["net1", "net2"]
for s in ["123", "true", "false", "null"]:
    assert wsp._parse_cli_networks(s) == [s]

# Rejection test helper
def assert_invalid(val):
    try:
        wsp._parse_cli_networks(val)
        raise AssertionError(f"expected failure for: {val!r}")
    except ValueError as err:
        assert str(err) == "ERR_INVALID_ARGS", f"expected ERR_INVALID_ARGS, got {err}"
        assert secret not in str(err), "secret input must not leak"

# 3. Non-string / boolean inputs
assert_invalid(True)
assert_invalid(False)
assert_invalid(123)
assert_invalid(f'[{secret}, 123]')
assert_invalid(f'["net1", true, "{secret}"]')

# 4. Blank string / whitespace
assert_invalid("")
assert_invalid("   ")
assert_invalid(f"net1, , {secret}")
assert_invalid(f'["net1", "", "{secret}"]')

# 5. Duplicates (CSV and JSON)
assert_invalid(f"{secret}, {secret}")
assert_invalid(f'["{secret}", "{secret}"]')

# 6. Malformed JSON
assert_invalid(f'["unclosed_{secret}')

# 7. Non-list JSON
assert_invalid(f'{{"key": "{secret}"}}')
assert_invalid(f'"{secret}"')

# 8. Empty list
assert_invalid("[]")

print("NETWORKS_PARSED_OK")`
    const res = sb.runPython(harnessPy, { args: [secretNet] })
    expect(res.status, res.stderr.slice(0, 500)).toBe(0)
    expect(res.stdout.trim()).toBe('NETWORKS_PARSED_OK')
    expect(res.stderr).not.toContain(secretNet)
  })

  it('uses typed ValueError for syntax errors and propagates control BaseExceptions without catching them', () => {
    sb = createPrivateSandbox()
    const harnessPy = `import sys, argparse
import scripts.web_only_state_publisher as wsp

# 1. Normal invalid argv raises typed ValueError("ERR_INVALID_ARGS")
try:
    wsp._parse_cli_syntax([])
    raise AssertionError("empty argv must fail")
except Exception as exc:
    assert isinstance(exc, ValueError), f"must be ValueError, got {type(exc)}"
    assert not isinstance(exc, (KeyboardInterrupt, SystemExit)), "must not be control BaseException"
    assert str(exc) == "ERR_INVALID_ARGS"

# 2. Control BaseException identity: KeyboardInterrupt must propagate without being swallowed
sentinel_ki = KeyboardInterrupt("intentional_interrupt_signal")
orig_parse = argparse.ArgumentParser.parse_args

def mock_ki_parse(*args, **kwargs):
    raise sentinel_ki

argparse.ArgumentParser.parse_args = mock_ki_parse
try:
    try:
        wsp._parse_cli_syntax(["--state-root", "/tmp"])
        raise AssertionError("should have raised KeyboardInterrupt")
    except BaseException as exc:
        assert exc is sentinel_ki, f"must propagate exact KeyboardInterrupt identity, got {type(exc)}"
finally:
    argparse.ArgumentParser.parse_args = orig_parse

# 3. Control BaseException identity: SystemExit(99) must propagate with exact identity and code 99
sentinel_exit = SystemExit(99)

def mock_exit_parse(*args, **kwargs):
    raise sentinel_exit

argparse.ArgumentParser.parse_args = mock_exit_parse
try:
    try:
        wsp._parse_cli_syntax(["--state-root", "/tmp"])
        raise AssertionError("should have raised SystemExit")
    except BaseException as exc:
        assert exc is sentinel_exit, f"must propagate exact SystemExit identity, got {type(exc)}"
        assert exc.code == 99, f"SystemExit code must be 99, got {exc.code}"
finally:
    argparse.ArgumentParser.parse_args = orig_parse

print("CONTROL_EXCEPTIONS_OK")`
    const res = sb.runPython(harnessPy)
    expect(res.status, res.stderr.slice(0, 500)).toBe(0)
    expect(res.stdout.trim()).toBe('CONTROL_EXCEPTIONS_OK')
  })
})
