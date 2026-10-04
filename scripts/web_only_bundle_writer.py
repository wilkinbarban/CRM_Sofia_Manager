"""Generic secure private bundle validator and writer module."""
import os
import stat


class FDOwnershipRegistry:
    """Registry tracking owned file descriptors with single-attempt close and pop-before-close."""

    def __init__(self) -> None:
        self._fds: list[int] = []

    def register(self, fd: int) -> int:
        """Register an owned descriptor. Returns the descriptor."""
        if fd is not None and fd >= 0 and fd not in self._fds:
            self._fds.append(fd)
        return fd

    def unregister(self, fd: int) -> int | None:
        """Unregister a descriptor without closing it."""
        if fd in self._fds:
            self._fds.remove(fd)
            return fd
        return None

    def close(self, fd: int) -> None:
        """Pop descriptor before close attempt; kernel release survives sentinel reuse."""
        if fd in self._fds:
            self._fds.remove(fd)
            os.close(fd)

    def close_all(self) -> None:
        """Close each owned descriptor with pop-before-close, single attempt, and error priority."""
        first_control: BaseException | None = None
        first_ordinary: BaseException | None = None
        while self._fds:
            fd = self._fds.pop()
            try:
                os.close(fd)
            except BaseException as err:
                if not isinstance(err, Exception):
                    if first_control is None:
                        first_control = err
                elif first_ordinary is None:
                    first_ordinary = err
        if first_control is not None:
            raise first_control
        if first_ordinary is not None:
            raise first_ordinary

    def safe_close_all(self, primary_err: BaseException | None = None) -> None:
        """Best-effort single close attempt for error cleanup, draining all owned descriptors.

        If primary_err is provided, suppresses secondary cleanup errors to preserve primary error.
        If primary_err is None, executes ordinary close semantics where control-flow BaseExceptions propagate.
        """
        if primary_err is None:
            self.close_all()
            return
        while self._fds:
            fd = self._fds.pop()
            try:
                os.close(fd)
            except BaseException:
                pass

    def __len__(self) -> int:
        return len(self._fds)


def safe_close_cleanup(fd: int, primary_err: BaseException | None = None) -> None:
    """Best-effort single close attempt during error cleanup.

    If primary_err is provided, suppresses secondary cleanup errors to preserve primary error.
    If primary_err is None, suppresses ordinary OSError but propagates control-flow BaseExceptions.
    """
    if fd is not None and fd >= 0:
        try:
            os.close(fd)
        except BaseException as err:
            if primary_err is None and not isinstance(err, Exception):
                raise


def write_all(fd: int, data: bytes) -> int:
    """Write data completely handling partial writes, raising on zero progress."""
    view = memoryview(data)
    total = 0
    while total < len(data):
        n = os.write(fd, view[total:])
        if n <= 0:
            raise OSError("write made zero progress or failed")
        total += n
    return total


def safe_unlink_devino(dir_fd: int, name: str, expected_dev: int, expected_ino: int) -> bool:
    """Safely unlink entry only if devino identity matches and is not a symlink.

    Returns True if unlinked, False if preserved (identity mismatch, symlink, or missing).
    Honest limits: stat+unlink is not atomic against same-UID concurrency; crash durability not guaranteed.
    """
    if expected_dev is None or expected_ino is None:
        return False
    try:
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except (FileNotFoundError, OSError):
        return False

    if stat.S_ISLNK(st.st_mode) or (st.st_dev, st.st_ino) != (expected_dev, expected_ino):
        return False

    try:
        os.unlink(name, dir_fd=dir_fd)
        return True
    except OSError:
        return False


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
            except BaseException as close_err:
                safe_close_cleanup(next_fd, primary_err=close_err)
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
    except BaseException as err:
        safe_close_cleanup(cur_fd, primary_err=err)
        raise
