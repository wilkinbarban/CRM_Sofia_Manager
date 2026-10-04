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
    parser.add_argument("--candidate-image", default=None)
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
    }, c


def inspect_candidate_image(endpoint: str, candidate_locator: str) -> str:
    raw = run_docker(endpoint, ["image", "inspect", candidate_locator.strip()])
    try:
        parsed = json.loads(raw)
    except Exception:
        emit_error("malformed image inspect json")
    if not isinstance(parsed, list) or len(parsed) != 1 or not isinstance(parsed[0], dict):
        emit_error("invalid image inspect structure")
    img = parsed[0]
    img_id = img.get("Id")
    if not isinstance(img_id, str) or not IMAGE_ID_PATTERN.fullmatch(img_id):
        emit_error("invalid candidate image id")
    if img.get("Architecture") != "amd64" or img.get("Os") != "linux":
        emit_error("invalid candidate image architecture or os")
    return img_id


def render_compose_config(endpoint: str, canonical_root: str, canonical_config: str, project: str) -> dict:
    raw = run_docker(endpoint, [
        "compose", "--project-directory", canonical_root, "--env-file", os.path.join(canonical_root, ".env"),
        "-f", canonical_config, "--project-name", project, "config", "--format", "json",
    ])
    try:
        parsed = json.loads(raw)
    except Exception:
        emit_error("malformed compose config json")
    services = parsed.get("services") if isinstance(parsed, dict) else None
    if not isinstance(services, dict) or not isinstance(services.get("web"), dict):
        emit_error("web service missing in compose config")
    return parsed


def validate_ports_and_mounts(c: dict, web_cfg: dict) -> None:
    host_cfg, net_settings = c.get("HostConfig"), c.get("NetworkSettings")
    if not isinstance(host_cfg, dict) or not isinstance(net_settings, dict):
        emit_error("invalid container host config or network settings")
    expected_binding = [{"HostIp": "127.0.0.1", "HostPort": "3020"}]
    if host_cfg.get("PortBindings") != {"3000/tcp": expected_binding}:
        emit_error("container port bindings mismatch")
    if net_settings.get("Ports") != {"3000/tcp": expected_binding}:
        emit_error("container network ports mismatch")
    r_ports = web_cfg.get("ports")
    if not isinstance(r_ports, list) or len(r_ports) != 1 or not isinstance(r_ports[0], dict):
        emit_error("compose web ports mismatch")
    p0 = r_ports[0]
    if str(p0.get("published")) != "3020" or str(p0.get("target")) != "3000" or p0.get("host_ip") != "127.0.0.1" or p0.get("protocol", "tcp") != "tcp":
        emit_error("compose web ports mismatch")
    if not isinstance(c.get("Mounts"), list) or len(c.get("Mounts")) != 0:
        emit_error("invalid container mounts")
    binds = host_cfg.get("Binds")
    if binds is not None and (not isinstance(binds, list) or len(binds) != 0):
        emit_error("unexpected container binds")
    vols = web_cfg.get("volumes")
    if "volumes" in web_cfg and (not isinstance(vols, list) or len(vols) != 0):
        emit_error("unexpected compose volumes")


def validate_networks(endpoint: str, c: dict, compose_doc: dict, project: str) -> list[str]:
    web_cfg = compose_doc["services"]["web"]
    if "networks" in compose_doc:
        top_nets = compose_doc["networks"]
        if not isinstance(top_nets, dict):
            emit_error("invalid compose networks structure")
    else:
        top_nets = {}
    if "networks" in web_cfg:
        w_nets = web_cfg["networks"]
        if isinstance(w_nets, list):
            if len(w_nets) == 0 or not all(isinstance(k, str) and k.strip() for k in w_nets):
                emit_error("invalid compose web networks")
            w_nets = {k: {} for k in w_nets}
        elif not isinstance(w_nets, dict) or len(w_nets) == 0:
            emit_error("invalid compose web networks")
    else:
        w_nets = {"default": {}}
    expected_nets: dict[str, dict] = {}
    for log_key, log_cfg in w_nets.items():
        if not isinstance(log_key, str) or not log_key.strip():
            emit_error("invalid network logical key")
        if not isinstance(log_cfg, dict):
            emit_error("invalid compose web networks")
        n_def = top_nets.get(log_key, {})
        if not isinstance(n_def, dict):
            emit_error("invalid compose network definition")
        if "name" in n_def:
            r_name = n_def["name"]
            if not isinstance(r_name, str) or not r_name.strip():
                emit_error("invalid compose network name")
        else:
            r_name = f"{project}_{log_key}"
        ext_val = n_def.get("external", False)
        if type(ext_val) is not bool:
            emit_error("invalid compose network external definition")
        aliases = log_cfg.get("aliases", [])
        if not isinstance(aliases, list) or not all(isinstance(a, str) and a.strip() for a in aliases):
            emit_error("invalid compose network aliases")
        expected_nets[r_name] = {"external": ext_val, "aliases": aliases}
    ctr_nets = c.get("NetworkSettings", {}).get("Networks")
    if not isinstance(ctr_nets, dict) or set(ctr_nets.keys()) != set(expected_nets.keys()):
        emit_error("container networks mismatch")
    for r_name, exp in expected_nets.items():
        c_net = ctr_nets[r_name]
        if not isinstance(c_net, dict):
            emit_error("invalid container network entry")
        net_id = c_net.get("NetworkID")
        if not isinstance(net_id, str) or not HEX_64_PATTERN.fullmatch(net_id):
            emit_error("invalid container network id")
        aliases = c_net.get("Aliases")
        if not isinstance(aliases, list) or not all(isinstance(a, str) for a in aliases):
            emit_error("invalid container network aliases")
        if not set(exp["aliases"]).issubset(set(aliases)):
            emit_error("container network aliases mismatch")
        n_raw = run_docker(endpoint, ["network", "inspect", net_id])
        try:
            n_parsed = json.loads(n_raw)
        except Exception:
            emit_error("malformed network inspect json")
        if not isinstance(n_parsed, list) or len(n_parsed) != 1 or not isinstance(n_parsed[0], dict):
            emit_error("invalid network inspect structure")
        n_info = n_parsed[0]
        if n_info.get("Id") != net_id or n_info.get("Name") != r_name:
            emit_error("network inspect metadata mismatch")
        if not exp["external"] and (not isinstance(n_info.get("Labels"), dict) or n_info["Labels"].get("com.docker.compose.project") != project):
            emit_error("network project ownership mismatch")
    return list(expected_nets.keys())


def inspect_and_validate_resources(
    endpoint: str, c: dict, cand_img: str, project: str, canonical_root: str, canonical_config: str,
) -> dict:
    cand_image_id = inspect_candidate_image(endpoint, cand_img)
    compose_doc = render_compose_config(endpoint, canonical_root, canonical_config, project)
    validate_ports_and_mounts(c, compose_doc["services"]["web"])
    nets = validate_networks(endpoint, c, compose_doc, project)
    return {
        "status": "ok",
        "action": "inspect-resources",
        "container_id": c.get("Id"),
        "container_name": str(c.get("Name", "")).lstrip("/"),
        "candidate_image_id": cand_image_id,
        "current_image_id": c.get("Image"),
        "project": project,
        "service": "web",
        "ports": {"target": 3000, "published": 3020, "host_ip": "127.0.0.1", "protocol": "tcp"},
        "networks": nets,
        "mounts": [],
        "endpoint": endpoint,
    }


def main() -> None:
    """Entry point for web-only operational target preflight validation."""
    try:
        args = parse_args()
        if args.generate or args.activate or args.action not in ("validate", "inspect-resources"):
            emit_error("resource validation and generation deferred to S3; activation is unsupported", code=2)
        if args.action == "inspect-resources" and (not args.candidate_image or not args.candidate_image.strip()):
            emit_error("candidate image locator required for inspect-resources", code=2)
        if args.service != "web":
            emit_error("only web service preflight supported in S2", code=2)
        endpoint = validate_environment(args.docker_host)
        canonical_root, canonical_config = validate_operational_root(args.root)
        target = resolve_container_id(endpoint, args.project, args.service, args.container)
        metadata, container_data = inspect_and_validate_target(endpoint, target, args.project, args.service, canonical_root, canonical_config)
        if args.action == "inspect-resources":
            metadata = inspect_and_validate_resources(endpoint, container_data, args.candidate_image, args.project, canonical_root, canonical_config)
        print(json.dumps(metadata, indent=2))
        sys.exit(0)
    except SystemExit:
        raise
    except Exception:
        emit_error("operational preflight failed")


if __name__ == "__main__":
    main()
