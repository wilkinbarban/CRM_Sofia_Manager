"""Anchored, capability-checked directory traversal with single descriptor ownership."""
import os
import stat

try:
    from scripts.web_only_bundle_writer import safe_close_cleanup
except ImportError:
    from web_only_bundle_writer import safe_close_cleanup

__all__ = ["open_state_dir", "open_state_root"]


def open_state_dir(state_dir: str) -> int:
    """Traverse and open private 0700 state directory via anchored dir_fd walk.

    Validates canonical absolute non-root path, ancestor permissions (root/uid0/euid non-writable
    unless rootsticky), terminal euid exact 0700 mode, and verifies dev/ino identity on every step.
    Returns caller-owned file descriptor. Caller assumes ownership and must close it.
    Honest limits: traversal only; no atomic creation, publication, or same-UID race guarantees.
    """
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise RuntimeError("platform lacks required O_NOFOLLOW or O_DIRECTORY capabilities")

    if not isinstance(state_dir, str) or not state_dir.strip():
        raise ValueError("state directory required")
    if not state_dir.startswith("/") or state_dir.startswith("//"):
        raise ValueError("state directory must start with a single slash")
    if state_dir != os.path.normpath(state_dir) or state_dir == "/" or state_dir.endswith("/"):
        raise ValueError("state directory path must be canonical, non-root, and absolute")

    parts = [p for p in state_dir.split("/") if p]
    cur_fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        st_root = os.fstat(cur_fd)
        if st_root.st_uid not in (0, os.geteuid()):
            raise PermissionError("root directory untrusted owner")
        if (st_root.st_mode & 0o022) != 0 and not (st_root.st_uid == 0 and (st_root.st_mode & stat.S_ISVTX)):
            raise PermissionError("root directory is writable without sticky bit")

        for idx, comp in enumerate(parts):
            is_terminal = (idx == len(parts) - 1)
            st_comp = os.stat(comp, dir_fd=cur_fd, follow_symlinks=False)
            if stat.S_ISLNK(st_comp.st_mode):
                raise PermissionError(f"path component is a symlink: {comp}")
            if not stat.S_ISDIR(st_comp.st_mode):
                raise NotADirectoryError(f"path component is not a directory: {comp}")
            pre_devino = (st_comp.st_dev, st_comp.st_ino)

            next_fd = os.open(comp, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=cur_fd)
            try:
                st_post = os.fstat(next_fd)
                if (st_post.st_dev, st_post.st_ino) != pre_devino:
                    raise PermissionError(f"path component identity mismatch after open: {comp}")
                if stat.S_ISLNK(st_post.st_mode) or not stat.S_ISDIR(st_post.st_mode):
                    raise PermissionError(f"path component type mismatch after open: {comp}")

                if is_terminal:
                    if st_post.st_uid != os.geteuid() or stat.S_IMODE(st_post.st_mode) != 0o700:
                        raise PermissionError(f"state directory owner or mode mismatch: {comp}")
                else:
                    if st_post.st_uid not in (0, os.geteuid()):
                        raise PermissionError(f"untrusted ancestor owner: {comp}")
                    if (st_post.st_mode & 0o022) != 0 and not (st_post.st_uid == 0 and (st_post.st_mode & stat.S_ISVTX)):
                        raise PermissionError(f"ancestor directory writable without sticky bit: {comp}")

                to_close = cur_fd
                cur_fd = next_fd
                next_fd = -1
                try:
                    os.close(to_close)
                except BaseException as close_err:
                    to_clean = cur_fd
                    cur_fd = -1
                    safe_close_cleanup(to_clean, primary_err=close_err)
                    raise close_err
            except BaseException as step_err:
                if next_fd >= 0:
                    to_clean = next_fd
                    next_fd = -1
                    safe_close_cleanup(to_clean, primary_err=step_err)
                raise step_err

        owned_fd = cur_fd
        cur_fd = -1
        return owned_fd
    except BaseException as err:
        if cur_fd >= 0:
            to_close = cur_fd
            cur_fd = -1
            safe_close_cleanup(to_close, primary_err=err)
        raise err


open_state_root = open_state_dir
