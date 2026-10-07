#!/usr/bin/env python3
"""Web-only bundle lifecycle management: allocate, validate, cleanup."""
import argparse
import os
import secrets
import stat
import sys

_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
for _p in (_SCRIPTS_DIR, os.path.dirname(_SCRIPTS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

try:
    from scripts.web_only_dir import open_state_dir
    from scripts.web_only_bundle_writer import (
        safe_close_cleanup, safe_unlink_devino, validate_bundle_target,
    )
    from scripts.web_only_bundle_consumer import (
        open_validated_bundle_fd, parse_json_safe, validate_effective_bundle,
    )
except ImportError:
    from web_only_dir import open_state_dir
    from web_only_bundle_writer import (
        safe_close_cleanup, safe_unlink_devino, validate_bundle_target,
    )
    from web_only_bundle_consumer import (
        open_validated_bundle_fd, parse_json_safe, validate_effective_bundle,
    )

__all__ = [
    "allocate_bundle_path", "validate_bundle", "cleanup_bundle", "main",
    "open_state_dir", "validate_bundle_target", "safe_unlink_devino",
    "safe_close_cleanup", "open_validated_bundle_fd", "parse_json_safe",
    "validate_effective_bundle",
]

KNOWN_BUNDLE_ENTRIES = frozenset({
    "manifest.json",
    "candidate-compose.json",
    "rollback-compose.json",
    ".manifest.json.tmp",
})


def allocate_bundle_path(state_root: str, max_attempts: int = 10) -> str:
    """Validate state root descriptor-first and allocate unguessable child path."""
    root_fd = open_state_dir(state_root)
    try:
        forced = os.environ.get("_TEST_FORCE_BUNDLE_TOKEN")
        for _ in range(max_attempts):
            token = forced or secrets.token_hex(16)
            name = f"bundle-{token}"
            try:
                os.stat(name, dir_fd=root_fd, follow_symlinks=False)
                if forced:
                    break
                continue
            except FileNotFoundError:
                return os.path.join(state_root, name)
        raise FileExistsError("failed to allocate unguessable bundle directory: collision")
    finally:
        safe_close_cleanup(root_fd)


def validate_bundle(
    bundle_dir: str, manifest_sha: str, project: str, candidate_image_id: str,
    current_image_id: str, container_id: str, networks: list[str],
) -> dict:
    """Run authoritative consumer validation and assert manifest metadata parity."""
    bundle = validate_effective_bundle(
        bundle_dir=bundle_dir, expected_manifest_sha256=manifest_sha,
        expected_project=project, expected_candidate_image_id=candidate_image_id,
        expected_current_image_id=current_image_id, expected_networks=networks,
    )
    for key, expected in (
        ("project", project), ("candidate_image_id", candidate_image_id),
        ("current_image_id", current_image_id), ("container_id", container_id),
    ):
        actual = bundle.get(key)
        if actual != expected:
            raise ValueError(f"{key} parity mismatch: expected {expected!r}, got {actual!r}")
    return bundle


def _verify_bundle_dir_stat(st: os.stat_result, context: str) -> None:
    """Verify bundle directory mode, type, and ownership."""
    if stat.S_ISLNK(st.st_mode):
        raise PermissionError(f"bundle directory is a symlink: {context}")
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or (st.st_mode & 0o777) != 0o700:
        raise PermissionError(f"bundle directory mode, owner, or type mismatch: {context}")


def cleanup_bundle(bundle_dir: str) -> None:
    """Safely cleanup private bundle directory using anchored descriptor operations."""
    if not bundle_dir or not isinstance(bundle_dir, str) or not bundle_dir.strip():
        raise ValueError("bundle directory required")
    if not os.path.isabs(bundle_dir) or bundle_dir != os.path.normpath(bundle_dir) or bundle_dir.endswith("/"):
        raise ValueError("bundle directory path must be canonical and absolute")

    parent_dir, base_name = os.path.dirname(bundle_dir), os.path.basename(bundle_dir)
    if parent_dir == "/":
        raise PermissionError("root directory cannot be immediate parent: must be private to user")

    try:
        parent_fd = open_state_dir(parent_dir)
    except FileNotFoundError:
        return
    try:
        try:
            st_bundle = os.stat(base_name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        _verify_bundle_dir_stat(st_bundle, base_name)
        bundle_identity = (st_bundle.st_dev, st_bundle.st_ino)

        bundle_fd = os.open(
            base_name,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_fd,
        )
        try:
            st_post = os.fstat(bundle_fd)
            if (st_post.st_dev, st_post.st_ino) != bundle_identity:
                raise PermissionError(f"bundle directory identity mismatch after open: {base_name}")
            _verify_bundle_dir_stat(st_post, f"{base_name} post-open")

            entries = os.listdir(bundle_fd)
            unknown = [e for e in entries if e not in KNOWN_BUNDLE_ENTRIES]
            if unknown:
                raise ValueError(f"bundle directory contains unknown extra entries: {sorted(unknown)}")

            verified_entries: list[tuple[str, int, int]] = []
            for name in entries:
                st_entry = os.stat(name, dir_fd=bundle_fd, follow_symlinks=False)
                if stat.S_ISLNK(st_entry.st_mode):
                    raise PermissionError(f"bundle entry is a symlink: {name}")
                if not stat.S_ISREG(st_entry.st_mode) or st_entry.st_uid != os.geteuid():
                    raise PermissionError(f"bundle entry invalid type or owner: {name}")
                verified_entries.append((name, st_entry.st_dev, st_entry.st_ino))

            for name, exp_dev, exp_ino in verified_entries:
                if not safe_unlink_devino(bundle_fd, name, exp_dev, exp_ino):
                    raise PermissionError(f"failed to safely unlink entry: {name}")
        finally:
            safe_close_cleanup(bundle_fd)

        st_final = os.stat(base_name, dir_fd=parent_fd, follow_symlinks=False)
        if (st_final.st_dev, st_final.st_ino) != bundle_identity:
            raise PermissionError(f"bundle directory identity mismatch before removal: {base_name}")
        _verify_bundle_dir_stat(st_final, f"{base_name} pre-removal")
        os.rmdir(base_name, dir_fd=parent_fd)
    finally:
        safe_close_cleanup(parent_fd)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Web-only bundle lifecycle CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    alloc_p = sub.add_parser("allocate")
    alloc_p.add_argument("--state-root", required=True)

    val_p = sub.add_parser("validate")
    for arg in (
        "--bundle-dir", "--manifest-sha", "--project", "--candidate-image-id",
        "--current-image-id", "--container-id", "--networks",
    ):
        val_p.add_argument(arg, required=True)

    clean_p = sub.add_parser("cleanup")
    clean_p.add_argument("--bundle-dir", required=True)

    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) and e.code != 0 else 2

    try:
        if args.command == "allocate":
            path = allocate_bundle_path(args.state_root)
            sys.stdout.write(path + "\n")
            return 0
        if args.command == "validate":
            nets = [n.strip() for n in args.networks.split(",") if n.strip()]
            validate_bundle(
                args.bundle_dir, args.manifest_sha, args.project,
                args.candidate_image_id, args.current_image_id,
                args.container_id, nets,
            )
            return 0
        if args.command == "cleanup":
            cleanup_bundle(args.bundle_dir)
            return 0
    except Exception as err:
        sys.stderr.write(f"{args.command} error: {err}\n")
        return 2

    return 2


if __name__ == "__main__":
    sys.exit(main())
