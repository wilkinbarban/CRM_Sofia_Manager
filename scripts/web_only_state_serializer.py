"""Inert pure v2 deployment state serializer."""
from typing import Any, Mapping

try:
    from scripts.web_only_state import (
        MAX_STATE_FILE_SIZE,
        REQUIRED_STATE_KEYS,
        ALLOWED_STATE_KEYS,
        parse_v2_release_env,
    )
except ImportError:
    from web_only_state import (
        MAX_STATE_FILE_SIZE,
        REQUIRED_STATE_KEYS,
        ALLOWED_STATE_KEYS,
        parse_v2_release_env,
    )

__all__ = ["serialize_v2_release_env"]

CANONICAL_KEYS = (
    "STATE_VERSION",
    "DEPLOY_MODE",
    "BUNDLE_DIR",
    "MANIFEST_SHA256",
    "COMPOSE_PROJECT",
    "OPERATIONAL_ROOT",
    "DOCKER_ENDPOINT",
    "EXPECTED_NETWORKS",
    "PREVIOUS_ID",
    "DEPLOYED_ID",
    "PREVIOUS_REF",
    "DEPLOYED_REF",
    "RECORDED_AT",
)
FORBIDDEN_CHARS = frozenset({"$", "`", "\\", "'", "\n", "\r", "\t", "\ufeff"})


def serialize_v2_release_env(state: Mapping[str, Any]) -> str:
    """Deterministically serialize v2 state mapping into safe quoted KEY='VALUE' lines.

    Enforces strict 10 required / 3 optional schema, rejecting non-strings, unknown keys,
    control chars, shell expansion chars ($, `, \\), single quotes, and BOM.
    Verifies lossless roundtrip through parse_v2_release_env within MAX_STATE_FILE_SIZE.
    """
    if not isinstance(state, Mapping):
        raise ValueError("state must be a mapping")
    keys = set(state.keys())
    if REQUIRED_STATE_KEYS - keys or keys - ALLOWED_STATE_KEYS:
        raise ValueError("state missing required keys or contains unknown keys")

    lines: list[str] = []
    for k in CANONICAL_KEYS:
        if k not in state:
            continue
        v = state[k]
        if type(v) is not str or not v.strip():
            raise ValueError(f"invalid value for key {k}: must be non-empty string")
        if any(c in FORBIDDEN_CHARS or ord(c) < 32 or ord(c) == 127 for c in v):
            raise ValueError(f"unsupported characters in value for key {k}")
        lines.append(f"{k}='{v}'")

    payload = "\n".join(lines) + "\n"
    try:
        raw = payload.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("unsupported characters in state payload") from None
    if len(raw) > MAX_STATE_FILE_SIZE:
        raise ValueError("serialized state exceeds maximum size")
    parsed = parse_v2_release_env(raw)
    if parsed != {k: state[k] for k in CANONICAL_KEYS if k in state}:
        raise ValueError("serialization roundtrip mismatch")
    return payload
