#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
compose_file="$root/ops/supabase/docker-compose.yml"
container="asados-supabase-db"
workspace="/tmp/asados-supabase-tests-$$"
database=
test_number=0

env_file=
checked_paths="$root/ops/supabase/.env"

canonical_root=
common_dir="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null || true)"
if [ -n "$common_dir" ]; then
  case "$common_dir" in
    /*) candidate_dir="$common_dir" ;;
    *) candidate_dir="$root/$common_dir" ;;
  esac
  candidate="$(CDPATH= cd -- "$candidate_dir/.." 2>/dev/null && pwd || true)"
  if [ -n "$candidate" ] && [ -d "$candidate" ] && [ "$candidate" != "$root" ]; then
    canonical_root="$candidate"
  fi
fi

if [ -z "$canonical_root" ]; then
  first_worktree="$(git -C "$root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -n 1 || true)"
  if [ -n "$first_worktree" ]; then
    candidate="$(CDPATH= cd -- "$first_worktree" 2>/dev/null && pwd || true)"
    if [ -n "$candidate" ] && [ -d "$candidate" ] && [ "$candidate" != "$root" ]; then
      canonical_root="$candidate"
    fi
  fi
fi

if [ -f "$root/ops/supabase/.env" ]; then
  env_file="$root/ops/supabase/.env"
elif [ -n "$canonical_root" ]; then
  canonical_env="$canonical_root/ops/supabase/.env"
  checked_paths="$checked_paths
$canonical_env"
  if [ -f "$canonical_env" ]; then
    env_file="$canonical_env"
  fi
fi

if [ -z "$env_file" ]; then
  echo "Missing self-hosted Supabase environment file." >&2
  echo "Checked paths:" >&2
  printf '%s\n' "$checked_paths" | sed 's/^/  - /' >&2
  echo "Generate the environment in the canonical checkout with: (cd ops/supabase && ./generate-env.sh)" >&2
  exit 1
fi

postgres_password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$env_file" | head -n 1)"
[ -n "$postgres_password" ] || { echo "Missing POSTGRES_PASSWORD in $env_file" >&2; exit 1; }
# The lifecycle harness opens dblink sessions. Its authenticated connection
# string is provided only to the disposable psql session and never echoed.
postgres_password_uri="$(node -p 'encodeURIComponent(process.argv[1])' "$postgres_password")"

cleanup_database() {
  [ -z "$database" ] || docker exec "$container" dropdb -U supabase_admin --if-exists --force "$database" >/dev/null 2>&1 || true
  database=
}

cleanup() {
  cleanup_database
  docker exec "$container" rm -rf "$workspace" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 129' HUP
trap 'cleanup; trap - EXIT; exit 130' INT
trap 'cleanup; trap - EXIT; exit 143' TERM

remediation_dir="ops/supabase"
if [ -n "$canonical_root" ]; then
  remediation_dir="$canonical_root/ops/supabase"
fi

posix_quote() {
  case "$1" in
    ""|*[!a-zA-Z0-9_./-]*)
      sq="'"
      q_sq="'\\"$sq"$sq"
      val="$1"
      res=""
      while :; do
        case "$val" in
          *"$sq"*)
            prefix="${val%%$sq*}"
            res="$res$prefix$q_sq"
            val="${val#*$sq}"
            ;;
          *)
            res="$res$val"
            break
            ;;
        esac
      done
      printf '%s' "$sq$res$sq"
      ;;
    *)
      printf '%s' "$1"
      ;;
  esac
}
remediation_dir="$(posix_quote "$remediation_dir")"

[ -f "$compose_file" ] || {
  echo "Missing self-hosted Supabase compose file: $compose_file" >&2
  exit 1
}

docker compose --env-file "$env_file" -f "$compose_file" config --quiet
docker compose --env-file "$env_file" -f "$compose_file" ps --status running db | grep -q . || {
  echo "Self-hosted Supabase db service is not running. Start it with: (cd $remediation_dir && docker compose up -d)" >&2
  exit 1
}

docker inspect --format '{{.State.Running}}' "$container" | grep -qx true || {
  echo "Expected self-hosted database container is not running: $container" >&2
  exit 1
}

docker exec "$container" psql -U supabase_admin -d postgres -Atqc "select 1 from pg_extension where extname = 'pgtap'" | grep -qx 1 || {
  echo "pgTAP extension is unavailable in $container" >&2
  exit 1
}

# Copy the harness workspace once. Each test gets a fresh database because a
# harness may import forward migrations that are intentionally non-reentrant.
docker exec "$container" mkdir -p "$workspace"
docker cp "$root/supabase/." "$container:$workspace"

run_test() {
  test_file="$1"
  test_number=$((test_number + 1))
  database="asados_sql_test_$$_$test_number"
  test_name="$(basename "$test_file")"
  runner="$workspace/run-$test_name"
  conninfo="postgresql://supabase_admin:${postgres_password_uri}@127.0.0.1:5432/${database}"

  # Supabase services keep connections to postgres open, so it cannot be used
  # as a template. Restore a clean clone for this test only. Realtime is omitted
  # because its locked runtime setting cannot be restored by the application role.
  docker exec "$container" createdb -U postgres "$database"
  docker exec "$container" sh -c "pg_dump -U supabase_admin --format=custom --exclude-schema=realtime postgres | pg_restore -U supabase_admin -d '$database' --exit-on-error"
  printf '\\ir tests/%s\n' "$test_name" \
    | docker exec -i "$container" sh -c "cat > '$runner'"
  echo "Running isolated self-hosted SQL test: $test_name"
  docker compose --env-file "$env_file" -f "$compose_file" exec -T db \
    psql -qX -U supabase_admin -d "$database" -v ON_ERROR_STOP=1 \
      -v "runtime_dblink_conninfo=$conninfo" \
      -f "$runner"
  cleanup_database
}

if [ "$#" -eq 0 ]; then
  set -- "$root"/supabase/tests/*.sql
fi

for test_file in "$@"; do
  case "$test_file" in
    /*) ;;
    *) test_file="$root/$test_file" ;;
  esac
  case "$test_file" in
    "$root"/supabase/tests/*.sql) ;;
    *) echo "Only files under supabase/tests may be run: $test_file" >&2; exit 2 ;;
  esac
  run_test "$test_file"
done
