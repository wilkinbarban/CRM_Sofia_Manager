"""Inert read-only bundle filesystem traversal and FD ownership primitive."""
import errno
import hashlib
import json
import math
import os
import re
import stat
from typing import Any, Mapping, Sequence, AbstractSet

try:
    from scripts.web_only_bundle_writer import FDOwnershipRegistry, safe_close_cleanup
except ImportError:
    from web_only_bundle_writer import FDOwnershipRegistry, safe_close_cleanup

__all__ = [
    "open_validated_bundle_fd",
    "read_private_entry",
    "parse_json_safe",
    "validate_effective_bundle",
    "FDOwnershipRegistry",
    "safe_close_cleanup",
]

HEX_64_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
IMAGE_ID_PATTERN = re.compile(r"^sha256:[0-9a-fA-F]{64}$")
CONTAINER_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")


ALLOWED_ENTRY_NAMES = frozenset({
    "manifest.json",
    "candidate-compose.json",
    "rollback-compose.json",
})


def open_validated_bundle_fd(bundle_dir: str) -> int:
    """Traverse and open validated inert bundle directory with ownership transfer to caller.

    Validates canonical absolute path, root and ancestor permissions, no symlinks,
    private 0700 bundle directory owned by current EUID, and verifies post-open fstat.
    Returns owned bundle file descriptor. Caller assumes ownership and must close it.
    Honest limits: traversal only; no payload validation, Compose promises, or same-UID race guarantees.
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
    if os.path.realpath(parent_dir) != parent_dir or os.path.realpath(bundle_dir) != bundle_dir:
        raise PermissionError("parent or bundle directory path contains symlinks or is not canonical")

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

            to_close = cur_fd
            cur_fd = -1
            try:
                os.close(to_close)
            except BaseException as close_err:
                safe_close_cleanup(next_fd, primary_err=close_err)
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

        st_pre = os.stat(base_name, dir_fd=cur_fd, follow_symlinks=False)
        if stat.S_ISLNK(st_pre.st_mode) or not stat.S_ISDIR(st_pre.st_mode) or st_pre.st_uid != os.geteuid() or (st_pre.st_mode & 0o777) != 0o700:
            raise PermissionError(f"bundle directory mode or owner mismatch: {base_name}")
        pre_devino = (st_pre.st_dev, st_pre.st_ino)

        bundle_fd = os.open(base_name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=cur_fd)
        try:
            st_post = os.fstat(bundle_fd)
            if (
                (st_post.st_dev, st_post.st_ino) != pre_devino
                or stat.S_ISLNK(st_post.st_mode)
                or not stat.S_ISDIR(st_post.st_mode)
                or st_post.st_uid != os.geteuid()
                or (st_post.st_mode & 0o777) != 0o700
            ):
                raise PermissionError(f"bundle directory identity or mode mismatch after open: {base_name}")

            to_close = cur_fd
            cur_fd = -1
            try:
                os.close(to_close)
            except BaseException as close_err:
                to_clean = bundle_fd
                bundle_fd = -1
                safe_close_cleanup(to_clean, primary_err=close_err)
                raise close_err

            owned_fd = bundle_fd
            bundle_fd = -1
            return owned_fd
        except BaseException as b_err:
            if bundle_fd >= 0:
                to_close_b = bundle_fd
                bundle_fd = -1
                safe_close_cleanup(to_close_b, primary_err=b_err)
            raise b_err
    except BaseException as err:
        if cur_fd >= 0:
            to_close = cur_fd
            cur_fd = -1
            safe_close_cleanup(to_close, primary_err=err)
        raise err


def read_private_entry(
    bundle_fd: int,
    name: str,
    registry: FDOwnershipRegistry | None = None,
) -> tuple[bytes, str]:
    """Read a validated private 0600 bundle entry from a caller-owned directory descriptor.

    Validates fixed allowed entry names (manifest.json, candidate-compose.json, rollback-compose.json),
    rejects path separators and traversals, enforces O_NOFOLLOW (fail-closed if unavailable) and
    O_NONBLOCK to prevent FIFO blocking before fstat, verifies regular file owned by current EUID with 0600
    permissions on the same descriptor, hashes read bytes, pops descriptor ownership before close,
    preserves primary exceptions if close fails, and guarantees caller-owned bundle_fd is never closed.
    Returns (data, sha256_hex) tuple.
    """
    if not isinstance(bundle_fd, int) or isinstance(bundle_fd, bool) or bundle_fd < 0:
        raise ValueError(f"invalid bundle_fd: {bundle_fd!r}")
    if not isinstance(name, str) or name not in ALLOWED_ENTRY_NAMES:
        raise ValueError(f"unauthorized entry name: {name!r}")
    if "/" in name or "\\" in name or os.path.basename(name) != name or name in (".", ".."):
        raise ValueError(f"invalid entry name path separators: {name!r}")

    o_nofollow = getattr(os, "O_NOFOLLOW", None)
    if o_nofollow is None:
        raise RuntimeError("O_NOFOLLOW unavailable on platform")

    flags = os.O_RDONLY | o_nofollow | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(name, flags, dir_fd=bundle_fd)
    except OSError as open_err:
        if open_err.errno == errno.ELOOP:
            raise PermissionError(f"entry is a symlink: {name}") from open_err
        raise

    if registry is not None:
        try:
            registry.register(fd)
        except BaseException as reg_err:
            target_fd = fd
            fd = -1
            safe_close_cleanup(target_fd, primary_err=reg_err)
            raise

    try:
        st = os.fstat(fd)
        if (
            not stat.S_ISREG(st.st_mode)
            or stat.S_ISLNK(st.st_mode)
            or st.st_uid != os.geteuid()
            or (st.st_mode & 0o777) != 0o600
        ):
            raise PermissionError(f"entry mode, owner, or type mismatch: {name}")

        chunks: list[bytes] = []
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        data = b"".join(chunks)
        digest = hashlib.sha256(data).hexdigest()

        target_fd = fd
        fd = -1
        if registry is not None:
            registry.close(target_fd)
        else:
            os.close(target_fd)
        return (data, digest)
    except BaseException as err:
        if fd >= 0:
            target_fd = fd
            if registry is not None:
                registry.unregister(target_fd)
            fd = -1
            safe_close_cleanup(target_fd, primary_err=err)
        raise


def parse_json_safe(data: bytes) -> dict:
    """Parse JSON payload with strict security invariants and generic error messages.

    Requires bytes input, valid UTF-8 encoding, object root, rejects duplicate keys at any nesting
    level, and rejects special floats (NaN, Infinity, -Infinity). Generic error messages avoid
    leaking payload snippets or secrets. No manifest or Compose schema validation performed.
    """
    if not isinstance(data, (bytes, bytearray)):
        raise ValueError("payload must be bytes")

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("invalid JSON payload: malformed UTF-8 encoding") from None

    def _parse_float(s: str) -> float:
        val = float(s)
        if not math.isfinite(val):
            raise ValueError("invalid JSON payload: special numbers (NaN/Infinity) are not allowed")
        return val

    def _reject_constant(_: str) -> None:
        raise ValueError("invalid JSON payload: special numbers (NaN/Infinity) are not allowed")

    def _check_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        obj: dict[str, Any] = {}
        for k, v in pairs:
            if k in obj:
                raise ValueError("invalid JSON payload: duplicate key detected")
            obj[k] = v
        return obj

    try:
        parsed = json.loads(
            text,
            object_pairs_hook=_check_pairs,
            parse_constant=_reject_constant,
            parse_float=_parse_float,
        )
    except (json.JSONDecodeError, ValueError) as err:
        msg = str(err)
        if msg.startswith("invalid JSON payload:"):
            raise ValueError(msg) from None
        raise ValueError("invalid JSON payload: syntax error") from None

    if not isinstance(parsed, dict):
        raise ValueError("invalid JSON payload: root must be a JSON object")

    return parsed


def _normalize_port_spec(p: Any) -> dict[str, Any]:
    if not isinstance(p, dict):
        raise ValueError("invalid port spec")
    pub, tgt = p.get("published"), p.get("target")
    if isinstance(pub, bool) or isinstance(tgt, bool):
        raise ValueError("port published and target cannot be bool")
    if str(pub) != "3020" or str(tgt) != "3000":
        raise ValueError("ports mapping mismatch: expected published 3020 and target 3000")
    if p.get("host_ip") != "127.0.0.1" or p.get("protocol", "tcp") != "tcp":
        raise ValueError("ports host_ip must be 127.0.0.1 and protocol tcp")
    return {"host_ip": "127.0.0.1", "published": 3020, "target": 3000, "protocol": "tcp"}


def _validate_compose_doc(doc: dict[str, Any], exp_image_id: str, exp_net_names: set[str]) -> None:
    if set(doc.keys()) - {"services", "networks"}:
        raise ValueError("unexpected top-level keys in compose payload")
    services = doc.get("services")
    if not isinstance(services, dict) or list(services.keys()) != ["web"]:
        raise ValueError("compose payload must define only web service")
    web = services["web"]
    if not isinstance(web, dict) or web.get("image") != exp_image_id:
        raise ValueError("invalid web service definition or image mismatch")
    if any(k in web for k in ("build", "depends_on", "volumes", "binds", "mounts")):
        raise ValueError("forbidden compose directive")
    ports = web.get("ports")
    if not isinstance(ports, list) or len(ports) != 1:
        raise ValueError("web service ports configuration mismatch")
    _normalize_port_spec(ports[0])
    web_nets, top_nets = web.get("networks"), doc.get("networks")
    if not isinstance(web_nets, dict) or set(web_nets.keys()) != exp_net_names or not isinstance(top_nets, dict) or set(top_nets.keys()) != exp_net_names:
        raise ValueError("compose networks mismatch")
    for n, cfg in web_nets.items():
        if not isinstance(cfg, dict) or set(cfg.keys()) - {"aliases"}:
            raise ValueError(f"invalid network config for {n}")
        aliases = cfg.get("aliases")
        if aliases is not None and (not isinstance(aliases, list) or not aliases or not all(isinstance(a, str) and a.strip() for a in aliases)):
            raise ValueError("network aliases must be a list of non-empty strings")
    for n, defn in top_nets.items():
        if (
            not isinstance(defn, dict)
            or set(defn.keys()) != {"name", "external"}
            or defn.get("external") is not True
            or defn.get("name") != n
        ):
            raise ValueError(f"network {n} must declare external: true and name: {n}")


def validate_effective_bundle(
    bundle_dir: str,
    expected_manifest_sha256: str,
    expected_project: str,
    expected_candidate_image_id: str,
    expected_current_image_id: str,
    expected_networks: Sequence[str] | AbstractSet[str],
) -> dict[str, Any]:
    """Validate inert read-only web-only deployment bundle.

    Opens bundle directory safely, validates manifest and compose payloads,
    and returns allowlisted metadata with single-attempt cleanup.
    """
    for val, name, pattern in [
        (expected_manifest_sha256, "manifest_sha256", HEX_64_PATTERN),
        (expected_candidate_image_id, "candidate_image_id", IMAGE_ID_PATTERN),
        (expected_current_image_id, "current_image_id", IMAGE_ID_PATTERN),
    ]:
        if not isinstance(val, str) or not pattern.fullmatch(val):
            raise ValueError(f"invalid {name}")
    if not isinstance(expected_project, str) or not expected_project.strip():
        raise ValueError("invalid expected_project")

    if isinstance(expected_networks, (str, bytes, Mapping)) or not isinstance(expected_networks, (Sequence, AbstractSet)):
        raise ValueError("expected_networks must be non-empty sequence or set of strings")
    exp_net_names = set(expected_networks)
    if not exp_net_names or not all(isinstance(n, str) and n.strip() for n in exp_net_names):
        raise ValueError("expected_networks must be non-empty sequence or set of strings")

    reg = FDOwnershipRegistry()
    raw_fd = open_validated_bundle_fd(bundle_dir)
    try:
        bundle_fd = reg.register(raw_fd)
    except BaseException as reg_err:
        safe_close_cleanup(raw_fd, primary_err=reg_err)
        raise

    try:
        m_bytes, m_sha = read_private_entry(bundle_fd, "manifest.json", registry=reg)
        if m_sha.lower() != expected_manifest_sha256.lower():
            raise ValueError("manifest sha mismatch")

        manifest = parse_json_safe(m_bytes)
        expected_fields = {
            "schema_version": "1.0", "project": expected_project, "service": "web",
            "candidate_image_id": expected_candidate_image_id, "current_image_id": expected_current_image_id,
            "candidate_compose_file": "candidate-compose.json", "rollback_compose_file": "rollback-compose.json",
        }
        if any(manifest.get(k) != v for k, v in expected_fields.items()):
            raise ValueError("manifest metadata mismatch")

        cid, cname = manifest.get("container_id"), manifest.get("container_name")
        if not isinstance(cid, str) or not HEX_64_PATTERN.fullmatch(cid):
            raise ValueError("invalid container_id in manifest")
        if not isinstance(cname, str) or not CONTAINER_NAME_PATTERN.fullmatch(cname):
            raise ValueError("invalid container_name in manifest")

        ports = _normalize_port_spec(manifest.get("ports"))

        m_nets = manifest.get("networks")
        if not isinstance(m_nets, list) or set(m_nets) != exp_net_names:
            raise ValueError("manifest networks mismatch")

        cand_exp_sha, roll_exp_sha = manifest.get("candidate_compose_sha256"), manifest.get("rollback_compose_sha256")
        if not (isinstance(cand_exp_sha, str) and HEX_64_PATTERN.fullmatch(cand_exp_sha) and isinstance(roll_exp_sha, str) and HEX_64_PATTERN.fullmatch(roll_exp_sha)):
            raise ValueError("invalid payload sha in manifest")

        cand_bytes, cand_sha = read_private_entry(bundle_fd, "candidate-compose.json", registry=reg)
        roll_bytes, roll_sha = read_private_entry(bundle_fd, "rollback-compose.json", registry=reg)
        if cand_sha != cand_exp_sha or roll_sha != roll_exp_sha:
            raise ValueError("payload sha mismatch")

        _validate_compose_doc(parse_json_safe(cand_bytes), expected_candidate_image_id, exp_net_names)
        _validate_compose_doc(parse_json_safe(roll_bytes), expected_current_image_id, exp_net_names)

        reg.close_all()
    except BaseException as err:
        reg.safe_close_all(primary_err=err)
        raise

    return {
        "status": "ok",
        "bundle_dir": bundle_dir,
        "manifest_path": os.path.join(bundle_dir, "manifest.json"),
        "candidate_compose_path": os.path.join(bundle_dir, "candidate-compose.json"),
        "rollback_compose_path": os.path.join(bundle_dir, "rollback-compose.json"),
        "manifest_sha256": m_sha,
        "candidate_compose_sha256": cand_sha,
        "rollback_compose_sha256": roll_sha,
        "project": expected_project,
        "service": "web",
        "candidate_image_id": expected_candidate_image_id,
        "current_image_id": expected_current_image_id,
        "networks": sorted(exp_net_names),
        "ports": ports,
        "container_id": cid,
        "container_name": cname,
    }
