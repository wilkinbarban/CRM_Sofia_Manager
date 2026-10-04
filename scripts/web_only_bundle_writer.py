"""Generic secure private bundle validator module with dirfd component walk."""
import os
import stat


def safe_close_cleanup(fd: int) -> None:
    """Best-effort single close attempt during error cleanup, preserving primary error."""
    if fd is not None and fd >= 0:
        try:
            os.close(fd)
        except OSError:
            pass


def validate_bundle_target(bundle_dir: str) -> tuple[int, str]:
    """Validate target path, ancestors, and parent permissions via dirfd component walk.

    Returns (parent_fd, base_name). On success, caller assumes ownership of parent_fd
    and must close it. On failure, a single close attempt is made for every owned descriptor
    preserving the primary error.
    """
    if not bundle_dir or not isinstance(bundle_dir, str) or not bundle_dir.strip():
        raise ValueError("bundle directory required")
    if not os.path.isabs(bundle_dir):
        raise ValueError("bundle directory must be an absolute path")
    if bundle_dir != os.path.normpath(bundle_dir) or (bundle_dir != "/" and bundle_dir.endswith("/")):
        raise ValueError("bundle directory path must be canonical and absolute")

    parent_dir = os.path.dirname(bundle_dir)
    base_name = os.path.basename(bundle_dir)
    if not base_name or not os.path.isdir(parent_dir):
        raise FileNotFoundError("parent directory does not exist")
    if parent_dir == "/":
        raise PermissionError("root directory cannot be immediate parent: must be private to user")
    if os.path.realpath(parent_dir) != parent_dir:
        raise PermissionError("parent directory path contains symlinks or is not canonical")

    parts = [p for p in parent_dir.split("/") if p]
    cur_fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        st_root = os.fstat(cur_fd)
        if st_root.st_uid not in (0, os.geteuid()):
            raise PermissionError("root directory untrusted owner")
        if (st_root.st_mode & 0o022) != 0 and not (st_root.st_uid == 0 and (st_root.st_mode & stat.S_ISVTX)):
            raise PermissionError("root directory is group or world writable without sticky bit")

        for idx, comp in enumerate(parts):
            is_immediate_parent = (idx == len(parts) - 1)
            st_comp = os.stat(comp, dir_fd=cur_fd, follow_symlinks=False)
            if stat.S_ISLNK(st_comp.st_mode):
                raise PermissionError(f"path component is a symlink: {comp}")

            next_fd = os.open(comp, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=cur_fd)
            # Mandatory transition: close cur_fd safely; if close fails, fail-closed and close next_fd
            try:
                os.close(cur_fd)
            except Exception as close_err:
                safe_close_cleanup(next_fd)
                cur_fd = -1
                raise close_err
            cur_fd = next_fd

            st = os.fstat(cur_fd)
            if is_immediate_parent:
                if st.st_uid != os.geteuid():
                    raise PermissionError("parent directory not owned by current user")
                if (st.st_mode & 0o022) != 0:
                    raise PermissionError("parent directory is group or world writable")
            else:
                if st.st_uid not in (0, os.geteuid()):
                    raise PermissionError(f"untrusted ancestor owner: {comp}")
                if (st.st_mode & 0o022) != 0 and not (st.st_uid == 0 and (st.st_mode & stat.S_ISVTX)):
                    raise PermissionError(f"ancestor directory is group or world writable without sticky bit: {comp}")

        exists = False
        try:
            os.stat(base_name, dir_fd=cur_fd, follow_symlinks=False)
            exists = True
        except FileNotFoundError:
            exists = False

        if exists:
            raise FileExistsError(f"bundle directory already exists: {base_name}")

        parent_fd = cur_fd
        cur_fd = -1
        return parent_fd, base_name
    except Exception:
        safe_close_cleanup(cur_fd)
        raise
