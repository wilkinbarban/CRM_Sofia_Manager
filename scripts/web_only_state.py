"""Inert pure typed v2 deployment state binding validator."""
import argparse
import errno
import os
import re
import stat
import sys
from typing import Any, Mapping, Sequence, AbstractSet

try:
    from scripts.web_only_bundle_consumer import parse_json_safe, validate_effective_bundle, safe_close_cleanup
except ImportError:
    from web_only_bundle_consumer import parse_json_safe, validate_effective_bundle, safe_close_cleanup

__all__ = ["validate_v2_bundle_state", "parse_v2_release_env", "read_safe_state_file", "main"]

HEX_64_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
IMAGE_ID_PATTERN = re.compile(r"^sha256:[0-9a-fA-F]{64}$")
IMAGE_REF_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._/:-]*:[a-zA-Z0-9._-]+$")
UTC_TIMESTAMP_PATTERN = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
SUPPORTED_DOCKER_ENDPOINT = "unix:///var/run/docker.sock"
MAX_STATE_FILE_SIZE = 65536

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

OPTIONAL_STATE_KEYS = frozenset({"PREVIOUS_REF", "DEPLOYED_REF", "RECORDED_AT"})
ALLOWED_STATE_KEYS = REQUIRED_STATE_KEYS | OPTIONAL_STATE_KEYS


def _is_valid_image_ref(r: str) -> bool:
    if not isinstance(r, str) or isinstance(r, bool) or not r.strip():
        return False
    if "@" in r or r.endswith(":latest"):
        return False
    return bool(IMAGE_REF_PATTERN.fullmatch(r))


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

    unknown = set(state.keys()) - ALLOWED_STATE_KEYS
    if unknown:
        raise ValueError("invalid state: unknown keys in state")

    for k in REQUIRED_STATE_KEYS:
        val = state[k]
        if not isinstance(val, str) or isinstance(val, bool) or not val.strip():
            raise ValueError("invalid state: required fields must be non-empty strings")

    if "PREVIOUS_REF" in state and not _is_valid_image_ref(state["PREVIOUS_REF"]):
        raise ValueError("invalid state: invalid PREVIOUS_REF")
    if "DEPLOYED_REF" in state and not _is_valid_image_ref(state["DEPLOYED_REF"]):
        raise ValueError("invalid state: invalid DEPLOYED_REF")
    if "RECORDED_AT" in state and not (isinstance(state["RECORDED_AT"], str) and UTC_TIMESTAMP_PATTERN.fullmatch(state["RECORDED_AT"])):
        raise ValueError("invalid state: invalid RECORDED_AT")

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


def read_safe_state_file(file_path: str) -> bytes:
    """Read validated 0600 state file via descriptor-anchored directory traversal.

    Rejects symlink components and entry with O_NOFOLLOW, enforces non-blocking open to
    prevent FIFO hangs, validates current-user ownership with mode 0600 on the opened descriptor,
    and bounds payload read to MAX_STATE_FILE_SIZE bytes. Guaranteed leak-free cleanup.
    """
    if not isinstance(file_path, str) or not file_path.strip() or not os.path.isabs(file_path) or file_path != os.path.normpath(file_path) or file_path.endswith("/") or file_path == "/":
        raise ValueError("state file path must be canonical, non-root, and absolute")

    parent_dir = os.path.dirname(file_path)
    file_name = os.path.basename(file_path)
    if not file_name or parent_dir == "/" or os.path.realpath(parent_dir) != parent_dir or os.path.realpath(file_path) != file_path:
        raise PermissionError("state file must reside in private canonical directory without symlinks")

    parts = [p for p in parent_dir.split("/") if p]
    cur_fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        st_root = os.fstat(cur_fd)
        if st_root.st_uid not in (0, os.geteuid()) or ((st_root.st_mode & 0o022) != 0 and not (st_root.st_uid == 0 and (st_root.st_mode & stat.S_ISVTX))):
            raise PermissionError("root directory untrusted owner or writable without sticky bit")

        for idx, comp in enumerate(parts):
            is_immediate_parent = (idx == len(parts) - 1)
            st_comp = os.stat(comp, dir_fd=cur_fd, follow_symlinks=False)
            if stat.S_ISLNK(st_comp.st_mode):
                raise PermissionError(f"path component is a symlink: {comp}")

            next_fd = os.open(comp, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=cur_fd)
            to_close, cur_fd = cur_fd, next_fd
            safe_close_cleanup(to_close)

            st = os.fstat(cur_fd)
            if is_immediate_parent:
                if st.st_uid != os.geteuid() or (st.st_mode & 0o022) != 0:
                    raise PermissionError("parent directory not private to current user")
            elif st.st_uid not in (0, os.geteuid()) or ((st.st_mode & 0o022) != 0 and not (st.st_uid == 0 and (st.st_mode & stat.S_ISVTX))):
                raise PermissionError(f"ancestor directory not private or trusted: {comp}")

        o_nofollow = getattr(os, "O_NOFOLLOW", 0)
        flags = os.O_RDONLY | o_nofollow | getattr(os, "O_NONBLOCK", 0)
        try:
            file_fd = os.open(file_name, flags, dir_fd=cur_fd)
        except OSError as open_err:
            if open_err.errno == errno.ELOOP:
                raise PermissionError(f"entry is a symlink: {file_name}") from None
            raise

        try:
            st_file = os.fstat(file_fd)
            if not stat.S_ISREG(st_file.st_mode) or stat.S_ISLNK(st_file.st_mode) or st_file.st_uid != os.geteuid() or (st_file.st_mode & 0o777) != 0o600:
                raise PermissionError(f"entry mode, owner, or type mismatch: {file_name}")

            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = os.read(file_fd, 65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_STATE_FILE_SIZE:
                    raise ValueError("payload exceeds maximum size")
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            safe_close_cleanup(file_fd)
    finally:
        safe_close_cleanup(cur_fd)


# Grammar note:
# Bash `printf %q` emits backslash escapes (e.g. `\\ `) and ANSI-C quoting (`$'...'`).
# The legacy reader in deploy-web.sh only stripped surrounding single/double quotes without
# executing general Bash unescaping. We do not claim general printf %q compatibility.
# The v2 grammar strictly accepts KEY=VALUE pairs with optional outer single or double quotes,
# preserving valid internal JSON quotes and paths with spaces, while rejecting ambiguous
# Bash escapes (\\), ANSI-C quoting ($''), and shell expansions ($, `).
# Future writers must serialize keys as KEY='VALUE' or KEY="VALUE" without backslash escapes.


def parse_v2_release_env(data: bytes | str) -> dict[str, str]:
    """Parse inert v2 release.env payload into dictionary of validated strings.

    Enforces strict non-executing grammar: rejects BOM, non-UTF8, control characters,
    multiline entries, duplicate/unknown/missing keys, and ambiguous Bash expansions.
    """
    if isinstance(data, str):
        data = data.encode("utf-8")
    elif not isinstance(data, (bytes, bytearray)):
        raise ValueError("payload must be bytes or string")

    if data.startswith(b"\xef\xbb\xbf"):
        raise ValueError("BOM detected in state file")

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("invalid UTF-8 encoding in state file") from None

    if any((ord(c) < 32 and c != "\n") or ord(c) == 127 for c in text):
        raise ValueError("control characters not allowed in state file")

    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines:
        raise ValueError("empty state file")

    state: dict[str, str] = {}
    for line in lines:
        if not line:
            raise ValueError("empty line in state file")
        if "=" not in line:
            raise ValueError(f"invalid line format: {line}")
        key, raw_val = line.split("=", 1)
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError(f"invalid key format: {key}")
        if key in state:
            raise ValueError(f"duplicate key in state file: {key}")
        if key not in ALLOWED_STATE_KEYS:
            raise ValueError(f"unknown key in state file: {key}")

        val = raw_val
        if (val.startswith("'") and val.endswith("'") and len(val) >= 2) or (
            val.startswith('"') and val.endswith('"') and len(val) >= 2
        ):
            val = val[1:-1]
        elif val.startswith("'") or val.startswith('"'):
            raise ValueError(f"unclosed quote in value for {key}")

        if any(tok in val for tok in ("$", "`", "\\")):
            raise ValueError(f"unsupported escape or expansion in {key}")

        if not val.strip():
            raise ValueError(f"empty value for key: {key}")
        state[key] = val

    missing = REQUIRED_STATE_KEYS - state.keys()
    if missing:
        raise ValueError("missing required keys in state file")

    return state


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        sys.stderr.write("ERR_INVALID_ARGS\n")
        sys.exit(2)


def _parse_cli_networks(val: str) -> list[str]:
    if not isinstance(val, str) or not val.strip():
        raise ValueError("empty networks")
    v = val.strip()
    if v.startswith("["):
        if not v.endswith("]"):
            raise ValueError("malformed networks JSON")
        lst = parse_json_safe(f'{{"_wrap": {v}}}'.encode("utf-8")).get("_wrap")
        if not isinstance(lst, list):
            raise ValueError("networks must be a list")
        return lst
    parts = [p.strip() for p in v.split(",") if p.strip()]
    if not parts:
        raise ValueError("empty networks")
    return parts


def main(argv: list[str] | None = None) -> int:
    """CLI transport executing safe v2 file parsing and bundle validation."""
    if argv is None:
        argv = sys.argv[1:]
    parser = SafeArgumentParser(add_help=False)
    for flag in ("--state-file", "--expected-root", "--expected-endpoint", "--expected-project", "--expected-networks"):
        parser.add_argument(flag, required=True)

    try:
        args = parser.parse_args(argv)
        exp_nets = _parse_cli_networks(args.expected_networks)
    except SystemExit as se:
        return int(se.code)
    except BaseException:
        sys.stderr.write("ERR_INVALID_ARGS\n")
        return 2

    try:
        raw = read_safe_state_file(args.state_file)
        state = parse_v2_release_env(raw)
        out = validate_v2_bundle_state(
            state,
            expected_root=args.expected_root,
            expected_endpoint=args.expected_endpoint,
            expected_project=args.expected_project,
            expected_networks=exp_nets,
        )

        b_dir = out.get("bundle_dir", "")
        r_compose = out.get("rollback_compose_path", "")
        prev_id = out.get("current_image_id", "")
        dep_id = out.get("candidate_image_id", "")

        for field in (b_dir, r_compose, prev_id, dep_id):
            if not isinstance(field, str) or not field.strip() or any(ord(c) < 32 or ord(c) == 127 for c in field):
                sys.stderr.write("ERR_VALIDATION_FAILED\n")
                return 1

        sys.stdout.write(f"ok\t{b_dir}\t{r_compose}\t{prev_id}\t{dep_id}\n")
        return 0
    except BaseException:
        sys.stderr.write("ERR_VALIDATION_FAILED\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
