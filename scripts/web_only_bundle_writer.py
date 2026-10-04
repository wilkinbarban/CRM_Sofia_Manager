"""Generic secure private bundle validator and writer module."""
import hashlib
import json
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


def write_private_entry(
    dir_fd: int,
    name: str,
    data: bytes,
    registry: FDOwnershipRegistry | None = None,
) -> tuple[int, int, str]:
    """Exclusively create 0600 file, fstat identity before write with single close attempt.

    Returns (st_dev, st_ino, sha256_hex). Unknown file preserved on validation failure.
    Honest limits: stat+unlink is not atomic against same-UID concurrency; crash durability not guaranteed.
    """
    if not name or not isinstance(name, str) or os.path.basename(name) != name or name in (".", "..") or "/" in name:
        raise ValueError(f"invalid entry name: {name!r}")

    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=dir_fd)
    if registry is not None:
        try:
            registry.register(fd)
        except BaseException as reg_err:
            safe_close_cleanup(fd, primary_err=reg_err)
            raise

    known_identity: tuple[int, int] | None = None
    try:
        st = os.fstat(fd)
        if st.st_uid != os.geteuid() or not stat.S_ISREG(st.st_mode) or (st.st_mode & 0o777) != 0o600:
            raise PermissionError(f"file permission or type mismatch: {name}")
        known_identity = (st.st_dev, st.st_ino)
        write_all(fd, data)
        digest = hashlib.sha256(data).hexdigest()

        target_fd = fd
        fd = -1
        if registry is not None:
            registry.close(target_fd)
        else:
            os.close(target_fd)
        return (known_identity[0], known_identity[1], digest)
    except BaseException as err:
        if fd >= 0:
            target_fd = fd
            if registry is not None:
                registry.unregister(target_fd)
            fd = -1
            safe_close_cleanup(target_fd, primary_err=err)
        if known_identity is not None:
            try:
                safe_unlink_devino(dir_fd, name, known_identity[0], known_identity[1])
            except BaseException:
                pass
        raise


def strict_link_manifest(
    dir_fd: int,
    tmp_name: str,
    final_name: str,
    expected_identity: tuple[int, int],
) -> tuple[int, int]:
    """Strictly link temporary manifest entry to final manifest location via atomic os.link.

    Guarantees atomic visibility at final_name via os.link without replace fallback.
    Honest limits:
    - os.link provides atomic directory entry visibility, not whole-workflow crash durability.
    - Not an atomic transaction across the workflow; rollback cleanup is best-effort.
    - Subject to same-UID TOCTOU concurrency between stat, link, and unlink.
    - Persistent stat failure preserves unknown entries rather than blind deletion.
    """
    if not isinstance(dir_fd, int) or isinstance(dir_fd, bool) or dir_fd < 0:
        raise ValueError(f"invalid dir_fd: {dir_fd!r}")
    if not tmp_name or not isinstance(tmp_name, str) or os.path.basename(tmp_name) != tmp_name or tmp_name in (".", "..") or "/" in tmp_name:
        raise ValueError(f"invalid tmp_name: {tmp_name!r}")
    if not final_name or not isinstance(final_name, str) or os.path.basename(final_name) != final_name or final_name in (".", "..") or "/" in final_name:
        raise ValueError(f"invalid final_name: {final_name!r}")
    if tmp_name == final_name:
        raise ValueError(f"tmp_name and final_name must be distinct: {tmp_name!r}")
    if (
        not isinstance(expected_identity, tuple)
        or len(expected_identity) != 2
        or not all(isinstance(x, int) and not isinstance(x, bool) for x in expected_identity)
    ):
        raise ValueError(f"invalid expected_identity: {expected_identity!r}")

    st_src = os.stat(tmp_name, dir_fd=dir_fd, follow_symlinks=False)
    if stat.S_ISLNK(st_src.st_mode):
        raise PermissionError(f"source entry is a symlink: {tmp_name}")
    if not stat.S_ISREG(st_src.st_mode) or (st_src.st_dev, st_src.st_ino) != expected_identity or st_src.st_uid != os.geteuid():
        raise PermissionError(f"source identity mismatch: {tmp_name}")

    link_created = False
    try:
        os.link(tmp_name, final_name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd, follow_symlinks=False)
        link_created = True

        st_dst = os.stat(final_name, dir_fd=dir_fd, follow_symlinks=False)
        if stat.S_ISLNK(st_dst.st_mode):
            raise PermissionError(f"destination entry is a symlink: {final_name}")
        if not stat.S_ISREG(st_dst.st_mode) or (st_dst.st_dev, st_dst.st_ino) != expected_identity or st_dst.st_uid != os.geteuid():
            raise PermissionError(f"destination identity mismatch: {final_name}")

        st_alias = os.stat(tmp_name, dir_fd=dir_fd, follow_symlinks=False)
        if (
            stat.S_ISLNK(st_alias.st_mode)
            or not stat.S_ISREG(st_alias.st_mode)
            or (st_alias.st_dev, st_alias.st_ino) != expected_identity
            or st_alias.st_uid != os.geteuid()
        ):
            raise PermissionError(f"temp alias identity mismatch: {tmp_name}")
        os.unlink(tmp_name, dir_fd=dir_fd)

        return expected_identity
    except BaseException:
        if link_created:
            try:
                safe_unlink_devino(dir_fd, final_name, expected_identity[0], expected_identity[1])
            except BaseException:
                pass
            try:
                safe_unlink_devino(dir_fd, tmp_name, expected_identity[0], expected_identity[1])
            except BaseException:
                pass
        raise


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


def write_effective_bundle(
    bundle_dir: str, candidate_content: bytes, rollback_content: bytes, manifest_metadata: dict | None = None,
) -> dict[str, str]:
    """Create private 0700 bundle directory with 0600 payloads and atomic manifest.

    Honest limits:
    - readonly manifest presence check and stat+unlink are not atomic against same-UID concurrency.
    - crash durability mid-run has no fsync guarantee across filesystem boundaries.
    - private owner trust boundary; no readiness proof by unchecked path.
    - foreign replacement directory and unknown files are preserved fail-closed without blind sweep.
    """
    registry = FDOwnershipRegistry()
    parent_fd, bundle_fd = -1, -1
    dir_created = False
    dir_identity: tuple[int, int] | None = None
    candidate_id: tuple[int, int] | None = None
    rollback_id: tuple[int, int] | None = None
    manifest_tmp_id: tuple[int, int] | None = None

    try:
        parent_fd, base_name = validate_bundle_target(bundle_dir)
        registry.register(parent_fd)

        os.mkdir(base_name, 0o700, dir_fd=parent_fd)
        dir_created = True

        st_created = os.stat(base_name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISDIR(st_created.st_mode) or stat.S_ISLNK(st_created.st_mode)
            or st_created.st_uid != os.geteuid() or (st_created.st_mode & 0o777) != 0o700
        ):
            raise PermissionError("created bundle directory mode, owner, or type mismatch")
        dir_identity = (st_created.st_dev, st_created.st_ino)

        bundle_fd = os.open(base_name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
        registry.register(bundle_fd)

        st_b = os.fstat(bundle_fd)
        st_check = os.stat(base_name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            (st_b.st_dev, st_b.st_ino) != dir_identity or (st_check.st_dev, st_check.st_ino) != dir_identity
            or st_b.st_uid != os.geteuid() or not stat.S_ISDIR(st_b.st_mode) or (st_b.st_mode & 0o777) != 0o700
        ):
            raise PermissionError("bundle directory identity or mode mismatch")

        c_dev, c_ino, cand_sha = write_private_entry(bundle_fd, "candidate-compose.json", candidate_content, registry=registry)
        candidate_id = (c_dev, c_ino)

        r_dev, r_ino, roll_sha = write_private_entry(bundle_fd, "rollback-compose.json", rollback_content, registry=registry)
        rollback_id = (r_dev, r_ino)

        reserved = {
            "schema_version", "candidate_compose_file", "candidate_compose_sha256",
            "rollback_compose_file", "rollback_compose_sha256",
        }
        filtered_metadata = {k: v for k, v in (manifest_metadata or {}).items() if k not in reserved}
        manifest_doc = {
            "schema_version": "1.0",
            **filtered_metadata,
            "candidate_compose_file": "candidate-compose.json",
            "candidate_compose_sha256": cand_sha,
            "rollback_compose_file": "rollback-compose.json",
            "rollback_compose_sha256": roll_sha,
        }
        manifest_bytes = (json.dumps(manifest_doc, indent=2) + "\n").encode("utf-8")
        manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()

        tmp_dev, tmp_ino, _ = write_private_entry(bundle_fd, ".manifest.json.tmp", manifest_bytes, registry=registry)
        manifest_tmp_id = (tmp_dev, tmp_ino)

        strict_link_manifest(bundle_fd, ".manifest.json.tmp", "manifest.json", manifest_tmp_id)
        manifest_tmp_id = None

        registry.close_all()
    except BaseException as primary_err:
        if manifest_tmp_id is not None and bundle_fd >= 0:
            try:
                safe_unlink_devino(bundle_fd, ".manifest.json.tmp", manifest_tmp_id[0], manifest_tmp_id[1])
            except BaseException:
                pass

        manifest_proven_absent = False
        if bundle_fd >= 0:
            try:
                os.stat("manifest.json", dir_fd=bundle_fd, follow_symlinks=False)
            except FileNotFoundError:
                manifest_proven_absent = True
            except OSError:
                pass

        if manifest_proven_absent:
            for fname, fident in (("candidate-compose.json", candidate_id), ("rollback-compose.json", rollback_id)):
                if fident is not None:
                    try:
                        safe_unlink_devino(bundle_fd, fname, fident[0], fident[1])
                    except BaseException:
                        pass

        if dir_created and dir_identity is not None and (manifest_proven_absent or bundle_fd < 0):
            try:
                cur_b = os.stat(base_name, dir_fd=parent_fd, follow_symlinks=False)
                if (
                    stat.S_ISDIR(cur_b.st_mode) and not stat.S_ISLNK(cur_b.st_mode)
                    and (cur_b.st_dev, cur_b.st_ino) == dir_identity
                    and cur_b.st_uid == os.geteuid() and (cur_b.st_mode & 0o777) == 0o700
                ):
                    os.rmdir(base_name, dir_fd=parent_fd)
            except BaseException:
                pass

        registry.safe_close_all(primary_err=primary_err)
        raise

    return {
        "status": "ok",
        "bundle_dir": os.path.realpath(bundle_dir),
        "candidate_compose_path": os.path.join(bundle_dir, "candidate-compose.json"),
        "rollback_compose_path": os.path.join(bundle_dir, "rollback-compose.json"),
        "manifest_path": os.path.join(bundle_dir, "manifest.json"),
        "candidate_compose_sha256": cand_sha,
        "rollback_compose_sha256": roll_sha,
        "manifest_sha256": manifest_sha,
    }
