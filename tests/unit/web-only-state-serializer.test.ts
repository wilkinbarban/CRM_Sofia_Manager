import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'

const PYTHON_BIN = '/usr/bin/python3'

function expectPy(code: string, expected = '') {
  const res = spawnSync(PYTHON_BIN, ['-B', '-c', code], {
    env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '.' },
    encoding: 'utf8',
  })
  expect(res.status).toBe(0)
  if (expected) expect(res.stdout.trim()).toBe(expected)
}

const BASE_FIXTURE = `
import scripts.web_only_state as ws
import scripts.web_only_state_serializer as wss

b = "1" * 64
base_state = {
    "STATE_VERSION": "2",
    "DEPLOY_MODE": "web-only",
    "BUNDLE_DIR": "/opt/crm/bundle",
    "MANIFEST_SHA256": b,
    "COMPOSE_PROJECT": "crm",
    "OPERATIONAL_ROOT": "/opt/crm/root",
    "DOCKER_ENDPOINT": "unix:///var/run/docker.sock",
    "EXPECTED_NETWORKS": '["net_a"]',
    "PREVIOUS_ID": "sha256:" + ("2" * 64),
    "DEPLOYED_ID": "sha256:" + ("3" * 64),
}
`

describe('web-only-state-serializer U2.3a-i standalone pure serializer', () => {
  it('verifies module exists and exports callable serialize_v2_release_env', () => {
    expectPy(`
import scripts.web_only_state_serializer as wss
assert callable(wss.serialize_v2_release_env)
assert not hasattr(wss, "publish_v2_release_state"), "standalone unit must not contain publisher"
assert wss.__all__ == ["serialize_v2_release_env"]
print("API_EXISTS")`, 'API_EXISTS')
  })

  it('serializes deterministically and roundtrips with quotes, spaces, and canonical order', () => {
    expectPy(`${BASE_FIXTURE}
st = dict(base_state)
st["OPERATIONAL_ROOT"] = "/opt/crm/my space dir"
st["PREVIOUS_REF"] = "crm-web:v1"
st["RECORDED_AT"] = "2026-10-05T09:00:00Z"
raw = wss.serialize_v2_release_env(st)
parsed = ws.parse_v2_release_env(raw)
assert parsed == st
assert "PREVIOUS_REF='crm-web:v1'" in raw
assert "OPERATIONAL_ROOT='/opt/crm/my space dir'" in raw

lines = raw.strip().split("\\n")
expected_keys = [
    "STATE_VERSION", "DEPLOY_MODE", "BUNDLE_DIR", "MANIFEST_SHA256", "COMPOSE_PROJECT",
    "OPERATIONAL_ROOT", "DOCKER_ENDPOINT", "EXPECTED_NETWORKS", "PREVIOUS_ID",
    "DEPLOYED_ID", "PREVIOUS_REF", "RECORDED_AT"
]
actual_keys = [line.split("=", 1)[0] for line in lines]
assert actual_keys == expected_keys
assert all(line.endswith("'") and "='" in line for line in lines)
print("ROUNDTRIP_OK")`, 'ROUNDTRIP_OK')
  })

  it('preserves all publisher rejection assertions for non-strings, unknown keys, and escapes', () => {
    expectPy(`${BASE_FIXTURE}
b = "x" * 64
base = {
    "STATE_VERSION": "2", "DEPLOY_MODE": "web-only", "BUNDLE_DIR": "/b",
    "MANIFEST_SHA256": b, "COMPOSE_PROJECT": "c", "OPERATIONAL_ROOT": "/r",
    "DOCKER_ENDPOINT": "unix:///var/run/docker.sock", "EXPECTED_NETWORKS": '["n"]',
    "PREVIOUS_ID": "sha256:" + b, "DEPLOYED_ID": "sha256:" + b
}
bad = [
    {**base, "STATE_VERSION": 2},
    {**base, "DEPLOY_MODE": False},
    {**base, "EXTRA": "val"},
    {k: v for k, v in base.items() if k != "DEPLOYED_ID"},
    {**base, "BUNDLE_DIR": "/b$bad"},
    {**base, "DEPLOY_MODE": "web\\x60bad\\x60"},
    {**base, "BUNDLE_DIR": "/b\\\\bad"},
    {**base, "BUNDLE_DIR": "/b'bad"},
    {**base, "RECORDED_AT": "2026-10-05\\n"},
]
for s in bad:
    try:
        wss.serialize_v2_release_env(s)
        raise AssertionError(f"should have failed for: {s}")
    except ValueError:
        pass
print("REJECT_SERIALIZE_OK")`, 'REJECT_SERIALIZE_OK')
  })

  it('handles optional metadata combinations and rejects invalid types/spaces on optional keys', () => {
    expectPy(`${BASE_FIXTURE}
# No optional keys
raw_min = wss.serialize_v2_release_env(base_state)
parsed_min = ws.parse_v2_release_env(raw_min)
assert parsed_min == base_state
assert "PREVIOUS_REF" not in parsed_min and "DEPLOYED_REF" not in parsed_min and "RECORDED_AT" not in parsed_min

# All 3 optional keys
all_opts = dict(base_state)
all_opts["PREVIOUS_REF"] = "registry.local/prev:v1.0"
all_opts["DEPLOYED_REF"] = "registry.local/dep:v2.0"
all_opts["RECORDED_AT"] = "2026-10-05T12:00:00Z"
raw_all = wss.serialize_v2_release_env(all_opts)
parsed_all = ws.parse_v2_release_env(raw_all)
assert parsed_all == all_opts

# Invalid optional key values
for bad_val in [123, None, True, "   ", ""]:
    st_bad = dict(base_state)
    st_bad["RECORDED_AT"] = bad_val
    try:
        wss.serialize_v2_release_env(st_bad)
        raise AssertionError(f"expected failure for optional value {bad_val}")
    except ValueError:
        pass
print("OPTIONAL_METADATA_OK")`, 'OPTIONAL_METADATA_OK')
  })

  it('rejects non-mapping, non-string keys, and each individual missing required key', () => {
    expectPy(`${BASE_FIXTURE}
# Non-mapping
for not_map in [None, 42, "string", [base_state]]:
    try:
        wss.serialize_v2_release_env(not_map)
        raise AssertionError(f"expected failure for non-mapping {not_map}")
    except ValueError:
        pass

# Non-string key
bad_key_dict = dict(base_state)
bad_key_dict[123] = "value"
try:
    wss.serialize_v2_release_env(bad_key_dict)
    raise AssertionError("expected failure for non-string key")
except ValueError:
    pass

# Missing required keys (each of the 10)
for k in base_state.keys():
    incomplete = {k2: v2 for k2, v2 in base_state.items() if k2 != k}
    try:
        wss.serialize_v2_release_env(incomplete)
        raise AssertionError(f"expected failure when missing required key {k}")
    except ValueError:
        pass
print("TYPE_AND_KEYS_OK")`, 'TYPE_AND_KEYS_OK')
  })

  it('enforces Unicode/control/BOM bounds and verifies safe multi-byte roundtrip', () => {
    expectPy(`${BASE_FIXTURE}
# Controls, null bytes, BOM, tabs, carriage returns
forbidden_values = [
    "val\\x00null", "val\\x07bell", "val\\x08bs", "val\\t tab",
    "val\\r cr", "val\\x1b esc", "val\\x7f del", "val\\ufeff bom",
    "val$dollar", "val\`tick", "val\\\\slash", "val'quote",
]
for fv in forbidden_values:
    bad_st = dict(base_state)
    bad_st["COMPOSE_PROJECT"] = fv
    try:
        wss.serialize_v2_release_env(bad_st)
        raise AssertionError(f"expected failure for character in {fv}")
    except ValueError:
        pass

# Valid multi-byte UTF-8 string roundtrips losslessly
valid_utf8_st = dict(base_state)
valid_utf8_st["OPERATIONAL_ROOT"] = "/opt/crm/serviço_españa_2026"
raw_utf8 = wss.serialize_v2_release_env(valid_utf8_st)
parsed_utf8 = ws.parse_v2_release_env(raw_utf8)
assert parsed_utf8["OPERATIONAL_ROOT"] == "/opt/crm/serviço_españa_2026"
print("UNICODE_BOUNDS_OK")`, 'UNICODE_BOUNDS_OK')
  })

  it('enforces maximum payload size boundary <= 65536 bytes UTF-8', () => {
    expectPy(`${BASE_FIXTURE}
huge_st = dict(base_state)
# MAX_STATE_FILE_SIZE is 65536. An oversized bundle dir will push it over.
huge_st["BUNDLE_DIR"] = "/opt/" + ("a" * 65536)
try:
    wss.serialize_v2_release_env(huge_st)
    raise AssertionError("expected failure for oversized payload")
except ValueError:
    pass

# Exact 65536 accepted and 65537 rejected regression
dummy_st = dict(base_state)
dummy_st["BUNDLE_DIR"] = "x"
base_raw_len = len(wss.serialize_v2_release_env(dummy_st).encode("utf-8"))
target_len = 1 + (65536 - base_raw_len)

exact_st = dict(base_state)
exact_st["BUNDLE_DIR"] = "x" * target_len
raw_exact = wss.serialize_v2_release_env(exact_st)
assert len(raw_exact.encode("utf-8")) == 65536
parsed_exact = ws.parse_v2_release_env(raw_exact)
assert len(parsed_exact["BUNDLE_DIR"]) == target_len

oversized_st = dict(base_state)
oversized_st["BUNDLE_DIR"] = "x" * (target_len + 1)
try:
    wss.serialize_v2_release_env(oversized_st)
    raise AssertionError("expected failure for 65537 bytes")
except ValueError as e:
    assert "exceeds maximum size" in str(e)
print("SIZE_BOUND_OK")`, 'SIZE_BOUND_OK')
  })

  it('catches UnicodeEncodeError on lone high/low surrogates and raises sanitized ValueError without leakage', () => {
    expectPy(`${BASE_FIXTURE}
import traceback
for surrogate in ["crm\\ud800bad", "crm\\udfffbad"]:
    bad_st = dict(base_state)
    bad_st["COMPOSE_PROJECT"] = surrogate
    try:
        wss.serialize_v2_release_env(bad_st)
        raise AssertionError(f"expected failure for surrogate: {repr(surrogate)}")
    except ValueError as err:
        assert type(err) is ValueError, f"expected exact ValueError, got {type(err)}"
        assert not isinstance(err, UnicodeError), "must not expose UnicodeError"
        assert err.__cause__ is None, "cause must be suppressed"
        assert err.__suppress_context__ is True, "context output must be suppressed"
        msg = str(err)
        assert "\\ud800" not in msg and "\\udfff" not in msg
        assert "codec" not in msg and "position" not in msg
        tb = "".join(traceback.format_exception(err))
        assert "UnicodeEncodeError" not in tb and "surrogates not allowed" not in tb
print("SURROGATE_SANITIZED_OK")`, 'SURROGATE_SANITIZED_OK')
  })
})
