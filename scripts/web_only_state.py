"""Inert pure typed v2 deployment state binding validator."""
import os
import re
from typing import Any, Mapping, Sequence, AbstractSet

try:
    from scripts.web_only_bundle_consumer import parse_json_safe, validate_effective_bundle
except ImportError:
    from web_only_bundle_consumer import parse_json_safe, validate_effective_bundle

__all__ = ["validate_v2_bundle_state"]

HEX_64_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
IMAGE_ID_PATTERN = re.compile(r"^sha256:[0-9a-fA-F]{64}$")
SUPPORTED_DOCKER_ENDPOINT = "unix:///var/run/docker.sock"

REQUIRED_STATE_KEYS = frozenset({
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
})


def _validate_caller_context(
    expected_root: str,
    expected_endpoint: str,
    expected_project: str,
    expected_networks: Sequence[str] | AbstractSet[str],
) -> set[str]:
    if not isinstance(expected_root, str) or isinstance(expected_root, bool) or not expected_root.strip():
        raise ValueError("invalid expected_root")
    if not os.path.isabs(expected_root) or expected_root != os.path.normpath(expected_root):
        raise ValueError("expected_root must be canonical and absolute")
    if expected_root != "/" and expected_root.endswith("/"):
        raise ValueError("expected_root must not end with trailing slash")
    if os.path.realpath(expected_root) != expected_root or not os.path.isdir(expected_root):
        raise ValueError("expected_root must exist without symlinks")

    if not isinstance(expected_endpoint, str) or isinstance(expected_endpoint, bool):
        raise ValueError("invalid expected_endpoint")
    if expected_endpoint != SUPPORTED_DOCKER_ENDPOINT:
        raise ValueError("unsupported docker endpoint: only local unix domain socket is supported")

    if not isinstance(expected_project, str) or isinstance(expected_project, bool) or not expected_project.strip():
        raise ValueError("invalid expected_project")

    if isinstance(expected_networks, (str, bytes, Mapping)) or not isinstance(expected_networks, (Sequence, AbstractSet)):
        raise ValueError("expected_networks must be a sequence or set of strings")
    if not expected_networks:
        raise ValueError("expected_networks must not be empty")

    exp_nets: set[str] = set()
    for n in expected_networks:
        if not isinstance(n, str) or isinstance(n, bool) or not n.strip() or n in exp_nets:
            raise ValueError("expected_networks must contain non-empty unique strings")
        exp_nets.add(n)

    return exp_nets


def validate_v2_bundle_state(
    state: Mapping[str, Any],
    *,
    expected_root: str,
    expected_endpoint: str,
    expected_project: str,
    expected_networks: Sequence[str] | AbstractSet[str],
) -> dict[str, Any]:
    """Validate inert v2 deployment state mapping and verify anchored effective bundle.

    Validates v2 state schema invariants, preflight caller context, and canonical operational
    root paths strictly before performing any bundle I/O. Symlinks are rejected and not canonicalized.
    Calls validate_effective_bundle with validated anchors and returns redacted bundle metadata.
    Honest limits: validates v2 binding only; does not parse raw env files or assert full state lifecycle.
    """
    exp_nets = _validate_caller_context(expected_root, expected_endpoint, expected_project, expected_networks)

    if not isinstance(state, Mapping):
        raise ValueError("invalid state: state must be a mapping")

    missing = REQUIRED_STATE_KEYS - state.keys()
    if missing:
        raise ValueError("invalid state: missing required keys")

    for k in REQUIRED_STATE_KEYS:
        val = state[k]
        if not isinstance(val, str) or isinstance(val, bool) or not val.strip():
            raise ValueError("invalid state: required fields must be non-empty strings")

    if state["STATE_VERSION"] != "2":
        raise ValueError("invalid state: STATE_VERSION must be '2'")
    if state["DEPLOY_MODE"] != "web-only":
        raise ValueError("invalid state: DEPLOY_MODE must be 'web-only'")

    if not HEX_64_PATTERN.fullmatch(state["MANIFEST_SHA256"]):
        raise ValueError("invalid state: invalid manifest sha256 anchor")
    if not IMAGE_ID_PATTERN.fullmatch(state["PREVIOUS_ID"]):
        raise ValueError("invalid state: invalid previous image id")
    if not IMAGE_ID_PATTERN.fullmatch(state["DEPLOYED_ID"]):
        raise ValueError("invalid state: invalid deployed image id")

    op_root = state["OPERATIONAL_ROOT"]
    if not os.path.isabs(op_root) or op_root != os.path.normpath(op_root) or (op_root != "/" and op_root.endswith("/")):
        raise ValueError("invalid state: operational root must be canonical and absolute")
    if os.path.realpath(op_root) != op_root or op_root != expected_root:
        raise ValueError("invalid state: operational root mismatch or contains symlinks")

    b_dir = state["BUNDLE_DIR"]
    if not os.path.isabs(b_dir) or b_dir != os.path.normpath(b_dir) or b_dir.endswith("/") or b_dir == "/":
        raise ValueError("invalid state: bundle directory must be canonical and absolute")
    if os.path.realpath(b_dir) != b_dir:
        raise ValueError("invalid state: bundle directory contains symlinks")

    if state["DOCKER_ENDPOINT"] != expected_endpoint:
        raise ValueError("invalid state: docker endpoint mismatch")
    if state["COMPOSE_PROJECT"] != expected_project:
        raise ValueError("invalid state: compose project mismatch")

    raw_nets = state["EXPECTED_NETWORKS"]
    if "\n" in raw_nets or "\r" in raw_nets:
        raise ValueError("invalid state: expected networks must be single-line JSON")

    wrapped = f'{{"_wrap": {raw_nets}}}'.encode("utf-8")
    try:
        parsed_wrap = parse_json_safe(wrapped)
    except ValueError:
        raise ValueError("invalid state: malformed expected networks JSON") from None

    if list(parsed_wrap.keys()) != ["_wrap"]:
        raise ValueError("invalid state: malformed expected networks payload structure")

    parsed_list = parsed_wrap["_wrap"]
    if not isinstance(parsed_list, list) or not parsed_list:
        raise ValueError("invalid state: expected networks must be a non-empty array")

    state_nets: set[str] = set()
    for item in parsed_list:
        if not isinstance(item, str) or isinstance(item, bool) or not item.strip() or item in state_nets:
            raise ValueError("invalid state: expected networks must contain non-empty unique strings")
        state_nets.add(item)

    if state_nets != exp_nets:
        raise ValueError("invalid state: expected networks mismatch")

    return validate_effective_bundle(
        bundle_dir=state["BUNDLE_DIR"],
        expected_manifest_sha256=state["MANIFEST_SHA256"],
        expected_project=expected_project,
        expected_candidate_image_id=state["DEPLOYED_ID"],
        expected_current_image_id=state["PREVIOUS_ID"],
        expected_networks=expected_networks,
    )
