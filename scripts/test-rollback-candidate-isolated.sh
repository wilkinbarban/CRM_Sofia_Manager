#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

# ==============================================================================
# Isolated Rollback-Candidate Compatibility Harness
# Pinned to the designated rollback commit; runs completely isolated from production.
# ==============================================================================

readonly PINNED_SOURCE_COMMIT="6eecb20502dbbfc8b5dc7c776d439443b306edb3"
readonly PRODUCTION_PROJECT_REF="xvzdxoktwnzmxsfizkxo"
readonly PRODUCTION_ORIGIN="crmsofiamanager.duckdns.org"
readonly PRODUCTION_IMAGE_ID="sha256:aa040fc915d1b6b75ecf9fcf26ec61f1c57cb56cdda75442bee34918dc856d74"
readonly DEFAULT_MIN_FREE_BYTES=12884901888

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly root

usage() {
  cat <<'EOF' >&2
Usage: scripts/test-rollback-candidate-isolated.sh <command>

Commands:
  plan     Resolve and print the deterministic image-level plan without mutation
  run      Execute the isolated build, disposable Supabase, and loopback probe
EOF
  exit 2
}

cmd="${1:-}"
[[ -n "$cmd" ]] || usage

case "$cmd" in
  plan|run) ;;
  *) usage ;;
esac

# ------------------------------------------------------------------------------
# Refusal: Inherited Supabase Environment Variables
# ------------------------------------------------------------------------------
for inherited in NEXT_PUBLIC_SUPABASE_URL SUPABASE_INTERNAL_URL SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_ANON_KEY; do
  if [[ -n "${!inherited:-}" ]]; then
    printf 'error: Refusing inherited Supabase environment: %s\n' "$inherited" >&2
    exit 1
  fi
done

# ------------------------------------------------------------------------------
# Refusal: Production Identifiers in Configuration
# ------------------------------------------------------------------------------
check_not_production_identifier() {
  local var_name="$1"
  local val="${!var_name:-}"
  [[ -n "$val" ]] || return 0

  if [[ "$val" == *"$PRODUCTION_PROJECT_REF"* || \
        "$val" == *"$PRODUCTION_ORIGIN"* || \
        "$val" == *"$PRODUCTION_IMAGE_ID"* || \
        "$val" == *"4d897d994bee8aa7332b57ca13dfad1d4c3c8430"* || \
        "$val" =~ ^asados-web: ]]; then
    printf 'error: Refusing: production identifier supplied through %s\n' "$var_name" >&2
    exit 1
  fi
}

check_not_production_identifier "ROLLBACK_HARNESS_IMAGE_TAG"
check_not_production_identifier "ROLLBACK_HARNESS_LOCK_DIR"
check_not_production_identifier "ROLLBACK_HARNESS_PROBE_PATH"
check_not_production_identifier "ROLLBACK_HARNESS_EXPECTED_DIGEST"
check_not_production_identifier "ROLLBACK_HARNESS_SOURCE_COMMIT"
check_not_production_identifier "ROLLBACK_HARNESS_PUBLIC_URL"
check_not_production_identifier "ROLLBACK_HARNESS_RUN_ID"
check_not_production_identifier "ROLLBACK_HARNESS_WORK_BASE"

# ------------------------------------------------------------------------------
# Configuration & Resource Derivation
# ------------------------------------------------------------------------------
source_commit="${ROLLBACK_HARNESS_SOURCE_COMMIT:-$PINNED_SOURCE_COMMIT}"
run_id="${ROLLBACK_HARNESS_RUN_ID:-$(date +%s)}"
lock_dir="${ROLLBACK_HARNESS_LOCK_DIR:-$root/.rollback-harness-lock}"
work_base="${ROLLBACK_HARNESS_WORK_BASE:-${TMPDIR:-/tmp}/rollback-harness-$run_id}"
min_free_bytes_threshold="${ROLLBACK_HARNESS_MIN_FREE_BYTES:-$DEFAULT_MIN_FREE_BYTES}"
probe_path="${ROLLBACK_HARNESS_PROBE_PATH:-/api/health/live}"

commit_short="${source_commit:0:7}"
owned_network="supabase_network_rollback-harness-${run_id}"
owned_container="rollback-candidate-isolated-${run_id}-web"
owned_image="${ROLLBACK_HARNESS_IMAGE_TAG:-asados-web-harness:${commit_short}-${run_id}}"

# ------------------------------------------------------------------------------
# Refusal: Public URL must be loopback
# ------------------------------------------------------------------------------
api_port="55521"
web_port="3030"
if [[ -n "${ROLLBACK_HARNESS_PUBLIC_URL:-}" ]]; then
  public_url="$ROLLBACK_HARNESS_PUBLIC_URL"
else
  public_url="http://127.0.0.1:${api_port}"
fi

if [[ ! "$public_url" =~ ^http://127\.0\.0\.1(:[0-9]+)?(/.*)?$ ]]; then
  printf 'error: Synthetic public URL must be loopback: %s\n' "$public_url" >&2
  exit 1
fi

web_url="http://127.0.0.1:${web_port}"

# ------------------------------------------------------------------------------
# Refusal: Source Commit must exist in repository
# ------------------------------------------------------------------------------
git -C "$root" rev-parse --verify --quiet "$source_commit^{commit}" >/dev/null || {
  printf 'error: Source commit %s is not present in this repository\n' "$source_commit" >&2
  exit 1
}

# ------------------------------------------------------------------------------
# Refusal: Docker Daemon Availability
# ------------------------------------------------------------------------------
docker info >/dev/null 2>&1 || {
  printf 'error: Docker is unavailable\n' >&2
  exit 1
}

# ------------------------------------------------------------------------------
# Refusal: Active Local Supabase Stack
# ------------------------------------------------------------------------------
if npx --no-install supabase status >/dev/null 2>&1; then
  printf 'error: Refusing to start a second disposable Supabase stack while a local stack is running\n' >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# Refusal: Owned Resource Collision
# ------------------------------------------------------------------------------
if docker network inspect "$owned_network" >/dev/null 2>&1; then
  printf 'error: Harness-owned network already exists: %s\n' "$owned_network" >&2
  exit 1
fi

if docker container inspect "$owned_container" >/dev/null 2>&1; then
  printf 'error: Harness-owned container already exists: %s\n' "$owned_container" >&2
  exit 1
fi

if docker image inspect "$owned_image" >/dev/null 2>&1; then
  printf 'error: Harness-owned image already exists: %s\n' "$owned_image" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# Refusal: Disk Headroom
# ------------------------------------------------------------------------------
check_dir="$work_base"
[[ -d "$check_dir" ]] || check_dir="$(dirname "$work_base")"
[[ -d "$check_dir" ]] || check_dir="${TMPDIR:-/tmp}"
available_bytes="$(df -P -B1 "$check_dir" 2>/dev/null | awk 'NR==2 {print $4}')"
if [[ -n "$available_bytes" ]] && (( available_bytes < min_free_bytes_threshold )); then
  printf 'error: Refusing to start without disk headroom above the required threshold: available %s < required %s\n' "$available_bytes" "$min_free_bytes_threshold" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# Refusal: Lock Management (Fail Closed on Active or Stale Lock)
# ------------------------------------------------------------------------------
mkdir -p "$lock_dir"
run_lock_dir="$lock_dir/run.lock"
check_lock() {
  local lock_pid="$(cat "$run_lock_dir/pid" 2>/dev/null || true)"
  if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
    printf 'error: Another isolated rollback harness run is active (pid: %s)\n' "$lock_pid" >&2
  else
    printf 'error: Refusing to continue on stale harness lock (pid: %s)\n' "$lock_pid" >&2
  fi
  exit 1
}
[[ -d "$run_lock_dir" ]] && check_lock

# ------------------------------------------------------------------------------
# Subcommand: plan
# ------------------------------------------------------------------------------
if [[ "$cmd" == "plan" ]]; then
  printf 'mode=plan\n'
  printf 'runtime=image-build+disposable-supabase+loopback-probe\n'
  printf 'source_commit=%s\n' "$source_commit"
  printf 'public_url=%s\n' "$public_url"
  printf 'web_url=%s\n' "$web_url"
  printf 'network_name=%s\n' "$owned_network"
  printf 'container_name=%s\n' "$owned_container"
  printf 'min_free_bytes=%s\n' "$DEFAULT_MIN_FREE_BYTES"
  exit 0
fi

# ------------------------------------------------------------------------------
# Execution Lifecycle (Isolated Run)
# ------------------------------------------------------------------------------
mkdir "$run_lock_dir" 2>/dev/null || check_lock
owned_lock=1
printf '%s\n' "$$" > "$run_lock_dir/pid"

started_by_runner=0
work="$work_base/run-${run_id}-$$"

cleanup() {
  if [[ "${started_by_runner:-0}" == "1" ]]; then
    docker rm -f "$owned_container" 2>/dev/null || true
    docker rmi "$owned_image" 2>/dev/null || true
    [[ "${owned_network_created:-0}" == "1" ]] && docker network rm "$owned_network" 2>/dev/null || true
    [[ "${owned_supabase:-0}" == "1" ]] && npx --no-install supabase stop --workdir "$work/project" --no-backup 2>/dev/null || true
    [[ "${owned_work:-0}" == "1" ]] && rm -rf "$work"
  fi
  [[ "${owned_lock:-0}" == "1" ]] && rm -rf "$run_lock_dir" 2>/dev/null || true
}

trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 129' HUP
trap 'cleanup; trap - EXIT; exit 130' INT
trap 'cleanup; trap - EXIT; exit 143' TERM

started_by_runner=1
mkdir -p "$work_base"
mkdir -m 700 "$work"
owned_work=1
mkdir -p "$work/project"

# Extract source without mutating working tree
git -C "$root" archive --format=tar "$source_commit" | tar -xf - -C "$work/project"

# Disposable Supabase lifecycle
owned_supabase=1
npx --no-install supabase start --workdir "$work/project"
npx --no-install supabase db reset --local --workdir "$work/project"
status_env="$(npx --no-install supabase status --workdir "$work/project" -o env)"

# Synthesised credentials safety gate checks
synthetic_url="$(printf '%s\n' "$status_env" | grep '^API_URL=' | cut -d= -f2- | tr -d '"' || true)"
synthetic_anon_key="$(printf '%s\n' "$status_env" | grep '^ANON_KEY=' | cut -d= -f2- | tr -d '"' || true)"

if [[ "$synthetic_url" != http://127.0.0.1* && "$synthetic_url" != http://localhost* ]]; then
  printf 'error: Safety gate rejected a non-local or protected Supabase target.\n' >&2
  exit 1
fi

if [[ -z "$synthetic_anon_key" || "$synthetic_anon_key" == *"placeholder"* ]]; then
  printf 'error: Safety gate rejected missing or placeholder synthetic credentials.\n' >&2
  exit 1
fi

# Build isolated image with loopback public args
docker network create "$owned_network"
owned_network_created=1
docker build -t "$owned_image" --build-arg "NEXT_PUBLIC_SUPABASE_URL=$public_url" --build-arg "NEXT_PUBLIC_SUPABASE_ANON_KEY=$synthetic_anon_key" -f "$work/project/Dockerfile" "$work/project"

# Run container on harness-owned network with loopback port mapping
docker run -d --network "$owned_network" --name "$owned_container" -p "127.0.0.1:${web_port}:3000" "$owned_image"

# Probe loopback health
curl --silent --show-error --fail --max-time 10 "http://127.0.0.1:${web_port}${probe_path}"

# Inspect built image ID
image_digest="$(docker image inspect "$owned_image" --format '{{.Id}}')"
printf 'compatible_image_id=%s\n' "$image_digest"
