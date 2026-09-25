#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
[[ "$(pwd -P)" == "$(git rev-parse --show-toplevel)" ]] || {
  printf '%s\n' 'Local Supabase test runner requires the repository root.' >&2
  exit 1
}

readonly local_api_url='http://127.0.0.1:55321'
readonly protected_project='xvzdxoktwnzmxsfizkxo'
readonly -a target_tests=(
  'tests/unit/roles-authentication-e2e.test.ts'
  'tests/unit/web-client-operator-cart-flow.test.ts'
)

tests_to_run=("${target_tests[@]}")
if (($#)); then
  tests_to_run=()
  for argument in "$@"; do
    allowed=false
    for target in "${target_tests[@]}"; do
      if [[ "$argument" == "$target" || "$argument" == "$root/$target" ]]; then
        tests_to_run+=("$target")
        allowed=true
        break
      fi
    done
    [[ "$allowed" == true ]] || {
      printf 'Only the two service-backed Supabase suites may run; rejected: %s\n' "$argument" >&2
      exit 2
    }
  done
fi

docker info >/dev/null 2>&1 || {
  printf '%s\n' 'Docker is unavailable; refusing to run service-backed tests.' >&2
  exit 1
}

work="$(mktemp -d "${TMPDIR:-/tmp}/asados-supabase-tests.XXXXXX")"
started_by_runner=false
cleanup() {
  code=$?
  trap - EXIT HUP INT TERM
  if [[ "$started_by_runner" == true ]]; then
    npx supabase stop --workdir "$work/project" --no-backup >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if npx supabase status >/dev/null 2>&1; then
  printf '%s\n' 'A local Supabase stack is already running. Refusing to reset shared developer state.' >&2
  exit 1
fi

# The production runner applies migrations as supabase_admin. Supabase CLI reserves
# that role and migrates as postgres, so ownership transfers cannot run locally.
# Prepare a private disposable migration tree and remove only those transfers.
mkdir -p "$work/project"
cp -a supabase "$work/project/supabase"
rm -f "$work/project/supabase/roles.sql"
python3 - "$work/project/supabase" <<'PY'
from pathlib import Path
import re
import sys

supabase_root = Path(sys.argv[1])
config_path = supabase_root / 'config.toml'
config = config_path.read_text()
ports = {54321: 55321, 54322: 55322, 54329: 55329, 54323: 55323, 54324: 55324, 54327: 55327}
for source, target in ports.items():
    config, count = re.subn(rf'(?m)^port = {source}$', f'port = {target}', config)
    if count != 1:
        raise SystemExit(f'expected one local port {source}, found {count}')
config, expose_count = re.subn(
    r'(?m)^# auto_expose_new_tables = false$',
    'auto_expose_new_tables = true',
    config,
)
config, phone_count = re.subn(
    r'(?ms)(^\[auth\.sms\]\n.*?^enable_signup = )false$',
    r'\1true',
    config,
)
config, provider_count = re.subn(
    r'(?ms)(^\[auth\.sms\.twilio\]\n^enabled = )false\n^account_sid = ""\n^message_service_sid = ""$',
    r'\1true\naccount_sid = "local-test"\nmessage_service_sid = "local-test"',
    config,
)
if expose_count != 1 or phone_count != 1 or provider_count != 1:
    raise SystemExit('expected local API grant and phone-auth settings')
config_path.write_text(config)

pattern = re.compile(r'^alter function public\.[^;]+ owner to supabase_admin;\n?', re.MULTILINE)
changed = 0
for path in (supabase_root / 'migrations').glob('*.sql'):
    source = path.read_text()
    rewritten, count = pattern.subn('', source)
    if count:
        path.write_text(rewritten)
        changed += count
if changed != 8:
    raise SystemExit(f'expected 8 local-only ownership transfers, found {changed}')
PY

# Deterministic, bounded classification of disposable startup and reset failures.
# Only fixed category labels, the last five migration filenames validated against a
# strict pattern, and one strict SQLSTATE code may reach stderr; unrecognized lines,
# paths, URLs, and credentials are never printed. Linux container startup failures
# (unhealthy/readiness, port conflicts, runtime availability, migration/database
# errors, timeouts) collapse into a closed label set that stays stable across log
# order and repeats. The scan is bounded by line and byte counts and the output by
# label count, so a huge or hostile log cannot stall the run or flood the operator.
report_failure_log() {
  local log=$1
  [[ -r "$log" && ! -d "$log" ]] || return 0

  local max_lines=2000
  local max_bytes=524288
  local max_migrations=5
  local max_labels=20

  local line lines=0
  local unhealthy=false port_conflict=false runtime_unavailable=false
  local database_error=false timed_out=false
  local migration_count=0 sqlstate=''
  local -a migrations=()

  while IFS= read -r line || [[ -n "$line" ]]; do
    lines=$((lines + 1))
    (( lines <= max_lines )) || break

    # Keep a fixed-size ring of the latest migration filenames: the failing
    # migration sits at the tail of the log, so reporting the first five hides it.
    if [[ "$line" =~ ^applying\ migration\ ([0-9]{14}_[a-z0-9_]+\.sql) ]]; then
      migrations[$((migration_count % max_migrations))]="${BASH_REMATCH[1]}"
      migration_count=$((migration_count + 1))
    fi
    # The only other token allowed to surface is a SQLSTATE code: exactly five
    # ASCII alphanumerics, required to follow the literal sqlstate context, and
    # bounded to the last occurrence. The surrounding message is never printed.
    if [[ "$line" =~ sqlstate[^0-9a-z]{0,4}([0-9a-z]{5})([^0-9a-z]|$) ]]; then
      sqlstate="${BASH_REMATCH[1]}"
    fi
    case "$line" in
      *unhealthy* | *'not ready'* | *readiness* | *'health check failed'*) unhealthy=true ;;
    esac
    case "$line" in
      *'address already in use'* | *'port is already allocated'* | *'port already in use'* | *'ports are not available'*) port_conflict=true ;;
    esac
    case "$line" in
      *'cannot connect to the docker daemon'* | *'error during connect'* | *'docker daemon'* | *'docker: command not found'* | *'cannot start container'* | *'failed to start container'* | *'exec format error'* | *'no space left on device'*) runtime_unavailable=true ;;
    esac
    case "$line" in
      *'error:'* | *'fatal:'* | *'failed to apply migration'* | *'migration failed'* | *'panic:'*) database_error=true ;;
    esac
    case "$line" in
      *'timed out'* | *timeout* | *'deadline exceeded'*) timed_out=true ;;
    esac
  # The guard above cannot close the read race: the log can become unreadable between the
  # check and the read, and head/tr would then print the ephemeral private path on stderr.
  # Only their stderr is discarded; the fixed labels below still reach the operator.
  done < <(head -c "$max_bytes" "$log" 2>/dev/null | tr '[:upper:]' '[:lower:]' 2>/dev/null)

  # Fixed emission order: the report is identical no matter how the log interleaves
  # these conditions, and it never repeats a label.
  local -a output=()
  local name retained=0 start=0 offset=0
  retained=${#migrations[@]}
  if (( retained )); then
    # Emit the retained tail in chronological order, oldest first, so the newest
    # (failing) migration is the last filename the operator reads.
    if (( migration_count >= max_migrations )); then
      start=$(( migration_count % max_migrations ))
    fi
    for ((offset = 0; offset < retained; offset++)); do
      name="${migrations[$(((start + offset) % max_migrations))]}"
      output+=("migration-file: $name")
    done
  fi
  if [[ -n "$sqlstate" ]]; then output+=("sqlstate: $sqlstate"); fi
  if [[ "$unhealthy" == true ]]; then output+=('startup-unhealthy-or-not-ready'); fi
  if [[ "$port_conflict" == true ]]; then output+=('port-conflict'); fi
  if [[ "$runtime_unavailable" == true ]]; then output+=('container-runtime-unavailable'); fi
  if [[ "$database_error" == true ]]; then output+=('migration-or-database-error'); fi
  if [[ "$timed_out" == true ]]; then output+=('startup-timeout'); fi

  local index=0 total=${#output[@]}
  if (( total > max_labels )); then total=$max_labels; fi
  while (( index < total )); do
    printf '%s\n' "${output[index]}" >&2
    index=$((index + 1))
  done
  return 0
}

export SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN='local-test-only'
if ! npx supabase start --workdir "$work/project" >"$work/start.log" 2>&1; then
  printf '%s\n' 'Disposable local Supabase failed to start.' >&2
  report_failure_log "$work/start.log"
  exit 1
fi
started_by_runner=true

if ! npx supabase db reset --local --workdir "$work/project" >"$work/reset.log" 2>&1; then
  printf '%s\n' 'Disposable local Supabase reset or seed failed.' >&2
  report_failure_log "$work/reset.log"
  exit 1
fi
npx supabase status --workdir "$work/project" -o env >"$work/status.env" 2>"$work/status.err"

status_value() {
  local name=$1
  sed -n "s/^${name}=\"\{0,1\}\([^\"[:space:]]*\)\"\{0,1\}$/\1/p" "$work/status.env" | head -1
}

api_url="$(status_value API_URL)"
anon_key="$(status_value ANON_KEY)"
service_key="$(status_value SERVICE_ROLE_KEY)"
if [[ "$api_url" != "$local_api_url" ]] || grep -Fq "$protected_project" "$work/status.env"; then
  printf '%s\n' 'Safety gate rejected a non-local or protected Supabase target.' >&2
  exit 1
fi
if [[ -z "$anon_key" || -z "$service_key" || "$anon_key" == ci-placeholder || "$service_key" == ci-placeholder ]]; then
  printf '%s\n' 'Safety gate rejected missing or placeholder local Supabase credentials.' >&2
  exit 1
fi

export NEXT_PUBLIC_SUPABASE_URL="$api_url"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$anon_key"
export SUPABASE_SERVICE_ROLE_KEY="$service_key"
export SUPABASE_INTERNAL_URL="$api_url"

scripts/workspace-preflight.sh run -- npx vitest run \
  "${tests_to_run[@]}" \
  --fileParallelism=false \
  --allowOnly=false
