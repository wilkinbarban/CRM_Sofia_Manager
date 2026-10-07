"""Inert pure v2 deployment state serializer and atomic state publisher."""
import argparse, json, os, stat
from typing import Any, Mapping, Sequence, AbstractSet

try:
    from scripts.web_only_state import validate_v2_bundle_state, parse_v2_release_env, _validate_caller_context
    from scripts.web_only_state_serializer import serialize_v2_release_env
    from scripts.web_only_bundle_writer import safe_close_cleanup, write_all, safe_unlink_devino
    from scripts.web_only_dir import open_state_root
except ImportError:
    from web_only_state import validate_v2_bundle_state, parse_v2_release_env, _validate_caller_context
    from web_only_state_serializer import serialize_v2_release_env
    from web_only_bundle_writer import safe_close_cleanup, write_all, safe_unlink_devino
    from web_only_dir import open_state_root

__all__ = ["serialize_v2_release_env", "publish_v2_release_state", "PostCommitSyncError"]


class PostCommitSyncError(RuntimeError):
    """Raised when release.env was atomically committed but directory fsync/close failed."""

    def __init__(self, message: str, *, state_file: str, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.state_file, self.cause, self.committed, self.durable = state_file, cause, True, False


def publish_v2_release_state(
    state_root: str,
    state: Mapping[str, Any],
    *,
    expected_root: str,
    expected_endpoint: str,
    expected_project: str,
    expected_networks: Sequence[str] | AbstractSet[str],
) -> dict[str, Any]:
    """Atomically publish validated v2 release state file into private state_root.

    Caller owns external concurrency locking contract (e.g. flock deploy.lock).
    Validates state and consumer bundle binding strictly before destination publication I/O.
    Fsyncs temporary descriptor before atomic replace; atomic replace guarantees visibility.
    Directory fsync/close failure after replace raises PostCommitSyncError(committed=True).
    Target release.env: compatible with old regular EUID-owned file (e.g. 0644) without chmod;
    new release.env is created with exact 0600 mode and atomically replaces destination.

    Failure semantics and cleanup boundaries:
    - Intentional unknown initial fstat failure, non-regular type, or foreign EUID preserves
      empty temp (no payload write before validation) without blind unlink before identity check.
    - Trusted regular descriptor with verified EUID cleans own identity on mode failure.
    - Directory fsync after replace is durability step that can fail postcommit; close failure
      may leave descriptor open or report error after release; ownership invalidated single attempt no guarantee universal leakfree.
    - Any ordinary Exception after confirmed commit (os.replace) raises PostCommitSyncError with
      committed=True, durable=False and cause preserved. Existing PostCommitSyncError retains identity. Control
      BaseExceptions (KeyboardInterrupt, SystemExit) propagate primary identity after cleanup.

    Honest limits: No crash durability across power loss without dir fsync; close that fails
    without releasing has ambiguous descriptor state, never retry (no universal drain guarantee);
    os.replace exception cannot prove actual commit state on hardware/kernel faults; no Docker in inert module.
    """
    validate_v2_bundle_state(
        state, expected_root=expected_root, expected_endpoint=expected_endpoint,
        expected_project=expected_project, expected_networks=expected_networks,
    )
    payload_bytes = serialize_v2_release_env(state).encode("utf-8")
    validate_v2_bundle_state(
        parse_v2_release_env(payload_bytes), expected_root=expected_root,
        expected_endpoint=expected_endpoint, expected_project=expected_project,
        expected_networks=expected_networks,
    )

    root_fd = open_state_root(state_root)
    tmp_fd = -1
    tmp_name: str | None = None
    own_devino: tuple[int, int] | None = None
    committed = False
    target_name = "release.env"
    target_path = os.path.join(state_root, target_name)

    try:
        try:
            st_tgt = os.stat(target_name, dir_fd=root_fd, follow_symlinks=False)
            if stat.S_ISLNK(st_tgt.st_mode) or not stat.S_ISREG(st_tgt.st_mode) or st_tgt.st_uid != os.geteuid():
                raise PermissionError("target release.env type or owner mismatch")
        except FileNotFoundError: pass

        tmp_name = f".release.env.tmp.{os.urandom(8).hex()}"
        tmp_fd = os.open(tmp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=root_fd)
        st_tmp = os.fstat(tmp_fd)
        if not stat.S_ISREG(st_tmp.st_mode) or stat.S_ISLNK(st_tmp.st_mode) or st_tmp.st_uid != os.geteuid():
            raise PermissionError("created temp file mode, owner, or type mismatch")
        own_devino = (st_tmp.st_dev, st_tmp.st_ino)
        if stat.S_IMODE(st_tmp.st_mode) != 0o600:
            raise PermissionError("created temp file mode, owner, or type mismatch")

        write_all(tmp_fd, payload_bytes)
        os.fsync(tmp_fd)
        to_close, tmp_fd = tmp_fd, -1
        safe_close_cleanup(to_close)

        st_check = os.stat(tmp_name, dir_fd=root_fd, follow_symlinks=False)
        if (st_check.st_dev, st_check.st_ino) != own_devino or not stat.S_ISREG(st_check.st_mode) or stat.S_ISLNK(st_check.st_mode) or st_check.st_uid != os.geteuid() or stat.S_IMODE(st_check.st_mode) != 0o600:
            raise PermissionError("temp file identity tampered before replace")

        os.replace(tmp_name, target_name, src_dir_fd=root_fd, dst_dir_fd=root_fd)
        committed, tmp_name = True, None

        sync_err = None
        try:
            os.fsync(root_fd)
        except Exception as err:
            sync_err = err

        to_close, root_fd = root_fd, -1
        if sync_err is not None:
            if isinstance(sync_err, PostCommitSyncError):
                primary = sync_err
            else:
                primary = PostCommitSyncError(f"state committed to {target_path} but directory fsync failed: {sync_err}", state_file=target_path, cause=sync_err)
            safe_close_cleanup(to_close, primary_err=primary)
            raise primary from (sync_err if sync_err is not primary else None)

        try:
            os.close(to_close)
        except Exception as close_err:
            if isinstance(close_err, PostCommitSyncError):
                raise
            raise PostCommitSyncError(f"state committed to {target_path} but directory close failed: {close_err}", state_file=target_path, cause=close_err) from close_err

        return {"status": "ok", "state_file": target_path, "committed": True, "durable": True}
    except BaseException as err:
        if not committed:
            if tmp_fd >= 0:
                to_close, tmp_fd = tmp_fd, -1
                safe_close_cleanup(to_close, primary_err=err)
            if tmp_name and own_devino:
                try: safe_unlink_devino(root_fd, tmp_name, own_devino[0], own_devino[1])
                except BaseException: pass
        if root_fd >= 0:
            to_close, root_fd = root_fd, -1
            safe_close_cleanup(to_close, primary_err=err)
        if committed:
            if not isinstance(err, Exception):
                raise
            if isinstance(err, PostCommitSyncError):
                raise
            raise PostCommitSyncError(f"state committed to {target_path} but postcommit operation failed: {err}", state_file=target_path, cause=err) from err
        raise


def _parse_cli_networks(value: str) -> list[str]:
    if not isinstance(value, str) or isinstance(value, bool):
        raise ValueError("ERR_INVALID_ARGS")
    v = value.strip()
    if not v:
        raise ValueError("ERR_INVALID_ARGS")
    raw_list: list[Any]
    if v.startswith(("[", "{", '"', "'")):
        try:
            parsed = json.loads(v)
        except Exception:
            raise ValueError("ERR_INVALID_ARGS") from None
        if not isinstance(parsed, list):
            raise ValueError("ERR_INVALID_ARGS")
        raw_list = parsed
    else:
        raw_parts = v.split(",")
        if any(not p.strip() for p in raw_parts):
            raise ValueError("ERR_INVALID_ARGS")
        raw_list = [p.strip() for p in raw_parts]

    if not raw_list:
        raise ValueError("ERR_INVALID_ARGS")
    result: list[str] = []
    seen: set[str] = set()
    for item in raw_list:
        if not isinstance(item, str) or isinstance(item, bool):
            raise ValueError("ERR_INVALID_ARGS")
        s = item.strip()
        if not s or s in seen:
            raise ValueError("ERR_INVALID_ARGS")
        seen.add(s)
        result.append(s)
    return result


class _SyntaxArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError("ERR_INVALID_ARGS")

    def exit(self, status: int = 0, message: str | None = None) -> None:
        raise ValueError("ERR_INVALID_ARGS")


def _parse_cli_syntax(argv: Sequence[str]) -> dict[str, Any]:
    if not isinstance(argv, (list, tuple)):
        raise ValueError("ERR_INVALID_ARGS")
    seen_flags: set[str] = set()
    for a in argv:
        if not isinstance(a, str) or isinstance(a, bool):
            raise ValueError("ERR_INVALID_ARGS")
        if a.startswith("-") and a != "-":
            flag = a.split("=", 1)[0]
            if flag in seen_flags:
                raise ValueError("ERR_INVALID_ARGS")
            seen_flags.add(flag)

    parser = _SyntaxArgumentParser(add_help=False, allow_abbrev=False)
    for flag in (
        "--state-root",
        "--bundle-dir",
        "--manifest-sha256",
        "--previous-id",
        "--deployed-id",
        "--expected-root",
        "--expected-endpoint",
        "--expected-project",
        "--expected-networks",
    ):
        parser.add_argument(flag, required=True)

    for flag in ("--previous-ref", "--deployed-ref", "--recorded-at", "--docker-endpoint"):
        parser.add_argument(flag, required=False, default=None)

    args = parser.parse_args(list(argv))
    parsed = vars(args)

    for k in (
        "state_root",
        "bundle_dir",
        "manifest_sha256",
        "previous_id",
        "deployed_id",
        "expected_root",
        "expected_endpoint",
        "expected_project",
    ):
        val = parsed[k]
        if not isinstance(val, str) or not val.strip():
            raise ValueError("ERR_INVALID_ARGS")

    for k in ("previous_ref", "deployed_ref", "recorded_at", "docker_endpoint"):
        val = parsed[k]
        if val is not None and (not isinstance(val, str) or not val.strip()):
            raise ValueError("ERR_INVALID_ARGS")

    parsed["expected_networks"] = _parse_cli_networks(parsed["expected_networks"])
    return parsed


def _parse_cli_args(argv: Sequence[str]) -> dict[str, Any]:
    try:
        syntax = _parse_cli_syntax(argv)
        docker_endpoint = syntax.get("docker_endpoint")
        expected_endpoint = syntax["expected_endpoint"]
        if docker_endpoint is not None and docker_endpoint != expected_endpoint:
            raise ValueError("ERR_INVALID_ARGS")

        _validate_caller_context(
            syntax["expected_root"],
            expected_endpoint,
            syntax["expected_project"],
            syntax["expected_networks"],
        )

        state: dict[str, str] = {
            "STATE_VERSION": "2",
            "DEPLOY_MODE": "web-only",
            "BUNDLE_DIR": syntax["bundle_dir"],
            "MANIFEST_SHA256": syntax["manifest_sha256"],
            "COMPOSE_PROJECT": syntax["expected_project"],
            "OPERATIONAL_ROOT": syntax["expected_root"],
            "DOCKER_ENDPOINT": docker_endpoint or expected_endpoint,
            "EXPECTED_NETWORKS": json.dumps(syntax["expected_networks"]),
            "PREVIOUS_ID": syntax["previous_id"],
            "DEPLOYED_ID": syntax["deployed_id"],
        }
        if syntax.get("previous_ref") is not None:
            state["PREVIOUS_REF"] = syntax["previous_ref"]
        if syntax.get("deployed_ref") is not None:
            state["DEPLOYED_REF"] = syntax["deployed_ref"]
        if syntax.get("recorded_at") is not None:
            state["RECORDED_AT"] = syntax["recorded_at"]

        return {
            "state_root": syntax["state_root"],
            "expected_root": syntax["expected_root"],
            "expected_endpoint": expected_endpoint,
            "expected_project": syntax["expected_project"],
            "expected_networks": syntax["expected_networks"],
            "state": state,
        }
    except Exception:
        err = ValueError("ERR_INVALID_ARGS")
        err.__suppress_context__ = True
        raise err from None
