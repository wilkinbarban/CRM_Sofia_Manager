"""Inert pure v2 deployment state serializer and atomic state publisher."""
import os, stat
from typing import Any, Mapping, Sequence, AbstractSet

try:
    from scripts.web_only_state import validate_v2_bundle_state, parse_v2_release_env
    from scripts.web_only_state_serializer import serialize_v2_release_env
    from scripts.web_only_bundle_writer import safe_close_cleanup, write_all, safe_unlink_devino
    from scripts.web_only_dir import open_state_root
except ImportError:
    from web_only_state import validate_v2_bundle_state, parse_v2_release_env
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
