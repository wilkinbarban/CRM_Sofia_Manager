#!/usr/bin/env python3
"""Web-only operational target preflight helper. Inert daemon/binding validation."""
import argparse
import json
import os
import re
import subprocess
import sys

DEFAULT_DOCKER_HOST = "unix:///var/run/docker.sock"
HEX_64_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
IMAGE_ID_PATTERN = re.compile(r"^sha256:[0-9a-fA-F]{64}$")


def emit_error(message: str, code: int = 1) -> None:
    print(json.dumps({"status": "error", "error": message}), file=sys.stdout)
    sys.exit(code)


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        emit_error("invalid command arguments", code=2)


def parse_args() -> argparse.Namespace:
    parser = SafeArgumentParser(description="Web-only target preflight", add_help=False)
    parser.add_argument("--help", "-h", action="store_true")
    parser.add_argument("--root", default=os.getcwd())
    parser.add_argument("--project", default="asados")
    parser.add_argument("--service", default="web")
    parser.add_argument("--container", default=None)
    parser.add_argument("--docker-host", default=DEFAULT_DOCKER_HOST)
    parser.add_argument("--generate", action="store_true")
    parser.add_argument("--activate", action="store_true")
    parser.add_argument("--action", default="validate")
    args = parser.parse_args()
    if getattr(args, "help", False):
        emit_error("invalid command arguments", code=2)
    return args


def validate_environment(docker_host: str) -> str:
    ctx = os.environ.get("DOCKER_CONTEXT")
    if ctx and ctx != "default":
        emit_error("conflicting DOCKER_CONTEXT override rejected")
    env_host = os.environ.get("DOCKER_HOST")
    if env_host and not env_host.startswith("unix://"):
        emit_error("remote or non-unix DOCKER_HOST rejected")
    if not docker_host.startswith("unix://"):
        emit_error("remote or non-unix docker host rejected")
    return docker_host


def validate_operational_root(root_path: str) -> tuple[str, str]:
    canonical_root = os.path.realpath(root_path)
    if not os.path.isdir(canonical_root):
        emit_error("operational root directory does not exist")
    yml, yaml = os.path.join(canonical_root, "docker-compose.yml"), os.path.join(canonical_root, "docker-compose.yaml")
    has_yml, has_yaml = os.path.isfile(yml), os.path.isfile(yaml)
    if has_yml and has_yaml:
        emit_error("ambiguous compose config files")
    if not has_yml and not has_yaml:
        emit_error("compose config file not found")
    canonical_config = os.path.realpath(yml if has_yml else yaml)
    if not os.path.isfile(os.path.join(canonical_root, ".env")):
        emit_error("env file not found in operational root")
    return canonical_root, canonical_config


def run_docker(endpoint: str, cmd_args: list[str]) -> str:
    sub_env = os.environ.copy()
    sub_env.pop("DOCKER_CONTEXT", None)
    sub_env["DOCKER_HOST"] = endpoint
    sub_env["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        proc = subprocess.run(
            ["docker", "--host", endpoint] + cmd_args,
            capture_output=True,
            text=True,
            timeout=10,
            env=sub_env,
        )
    except subprocess.TimeoutExpired:
        emit_error("docker command timed out")
    except Exception:
        emit_error("docker execution failed")
    if proc.returncode != 0:
        emit_error("docker command execution failed")
    return proc.stdout


def resolve_container_id(endpoint: str, project: str, service: str, container_hint: str | None) -> str:
    if container_hint:
        return container_hint
    ps_args = [
        "ps", "-aq",
        "--filter", f"label=com.docker.compose.project={project}",
        "--filter", f"label=com.docker.compose.service={service}",
    ]
    ps_out = run_docker(endpoint, ps_args)
    lines = [line.strip() for line in ps_out.strip().splitlines() if line.strip()]
    if not lines:
        return f"{project}-{service}" if project != "asados" else "crm-sofia-web"
    if len(lines) > 1:
        emit_error("duplicate containers found for service")
    return lines[0]


def inspect_and_validate_target(
    endpoint: str, target: str, expected_project: str, expected_service: str, canonical_root: str, canonical_config: str,
) -> dict:
    inspect_raw = run_docker(endpoint, ["inspect", target])
    try:
        parsed = json.loads(inspect_raw)
    except Exception:
        emit_error("malformed docker inspect json")
    if not isinstance(parsed, list) or len(parsed) == 0:
        emit_error("invalid container inspect structure")
    if len(parsed) > 1:
        emit_error("duplicate containers returned by inspect")
    c = parsed[0]
    if not isinstance(c, dict):
        emit_error("malformed container record structure")

    c_id = c.get("Id")
    if not isinstance(c_id, str) or not HEX_64_PATTERN.fullmatch(c_id):
        emit_error("invalid container id format")
    c_name = c.get("Name")
    if not isinstance(c_name, str) or not c_name.strip():
        emit_error("invalid container name")
    img_id = c.get("Image")
    if not isinstance(img_id, str) or not IMAGE_ID_PATTERN.fullmatch(img_id):
        emit_error("invalid container image id")

    config_dict = c.get("Config")
    if not isinstance(config_dict, dict):
        emit_error("invalid container inspect structure")
    img_ref = config_dict.get("Image")
    if not isinstance(img_ref, str) or not img_ref.strip():
        emit_error("invalid container image reference")
    labels = config_dict.get("Labels")
    if not isinstance(labels, dict):
        emit_error("invalid container inspect structure")

    actual_svc = labels.get("com.docker.compose.service")
    if not isinstance(actual_svc, str) or actual_svc != expected_service:
        emit_error("container service mismatch")
    actual_proj = labels.get("com.docker.compose.project")
    if not isinstance(actual_proj, str) or actual_proj != expected_project:
        emit_error("container project mismatch")
    actual_wdir = labels.get("com.docker.compose.project.working_dir")
    if not isinstance(actual_wdir, str) or not actual_wdir.strip() or os.path.realpath(actual_wdir) != canonical_root:
        emit_error("container working directory mismatch")
    actual_cfiles = labels.get("com.docker.compose.project.config_files")
    if not isinstance(actual_cfiles, str) or not actual_cfiles.strip():
        emit_error("container config files label missing")
    cfile_paths = [os.path.realpath(p.strip()) for p in actual_cfiles.split(",") if p.strip()]
    if len(cfile_paths) != 1 or cfile_paths[0] != canonical_config:
        emit_error("container config files mismatch")

    return {
        "status": "ok",
        "container_id": c_id,
        "container_name": c_name.lstrip("/"),
        "image_id": img_id,
        "image_ref": img_ref,
        "project": actual_proj,
        "service": actual_svc,
        "working_dir": canonical_root,
        "config_files": canonical_config,
        "endpoint": endpoint,
        "env_file_present": True,
    }


def main() -> None:
    """Entry point for web-only operational target preflight validation."""
    try:
        args = parse_args()
        if args.generate or args.activate or args.action != "validate":
            emit_error("resource validation and generation deferred to S3; activation is unsupported", code=2)
        if args.service != "web":
            emit_error("only web service preflight supported in S2", code=2)
        endpoint = validate_environment(args.docker_host)
        canonical_root, canonical_config = validate_operational_root(args.root)
        target = resolve_container_id(endpoint, args.project, args.service, args.container)
        metadata = inspect_and_validate_target(endpoint, target, args.project, args.service, canonical_root, canonical_config)
        print(json.dumps(metadata, indent=2))
        sys.exit(0)
    except SystemExit:
        raise
    except Exception:
        emit_error("operational preflight failed")


if __name__ == "__main__":
    main()
