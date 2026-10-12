#!/usr/bin/env bash
#
# Disposable local pgTAP runner for the Sofia SQL suites.
#
# The runner stages allowlisted SQL and a generated config in a private project, starts a
# Supabase stack under a unique project id and probe-selected free ports, applies the
# full migration chain plus seed, and then runs each requested suite in a freshly reset
# database through the database container's own psql client. The dblink connection
# string handed to a suite always targets that same disposable database.
#
# Before each psql invocation the harness proves with a bounded preflight that the suite
# file and every relative `\ir` include it resolves are present inside the container, and
# restages the tree when the preceding `supabase db reset` discarded it.
#
# Safety properties:
#   * no shared or production database is touched; ops/ environment files are never read;
#   * every docker operation is scoped by the unique project-id label of this run;
#   * local credentials stay in a 0600 temporary file and are never printed;
#   * TAP output is validated with a real parser, so a pgTAP assertion failure fails the
#     run even when psql exits 0;
#   * the stack, its containers, its network, and the temporary tree are removed on
#     success, failure, timeout, and ordinary signals (TERM, HUP, INT all funnel through
#     the EXIT trap, which restores the console descriptors so its report stays visible).
#     SIGKILL and SIGSTOP cannot be trapped, so a hard kill leaves the labelled resources
#     and the temporary tree behind for an explicit cleanup run; the heartbeat child still
#     stops on its own because it watches this process id.
#   * every long step is bounded and prints a progress heartbeat, so the harness is never
#     silent for minutes while it captures output for redaction; a step that hits its limit
#     reports the timeout explicitly instead of failing anonymously.
#
# Local compatibility normalization (applied only to the temporary copy, never to the
# repository): project id, ports, removal of roles.sql, and removal of the counted
# `owner to supabase_admin` transfers that the hosted runner applies but the local CLI
# cannot reproduce. See the printed normalization line for the exact counts.
#
# Inside its own container the disposable database also gets one ephemeral loopback password
# rule (see ensure_loopback_password_rule); it never reaches the host or the repository.

# Supported: execute with trusted Bash startup hooks and exported functions.
# For clean Bash startup, launch from a trusted caller with an empty environment:
# /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /bin/bash --noprofile --norc \
#   scripts/run-local-sofia-sql-tests.sh --self-check
# Bash startup hooks/functions run BEFORE this file; we cannot protect that shell.
# Refuse sourcing before changing caller state, even when the caller spoofs $0.
if (return 0 2>/dev/null); then
  printf 'error: execute this runner; do not source it\n' >&2
  return 1
fi

# Only these explicit variables reach tools. DO_NOT_TRACK is a configured opt-out;
# provider support and suppression of telemetry traffic have NOT been verified.
# Supabase remains repository-pinned; PATH and the Docker socket are explicitly local.
sanitized_exec() {
  local home=$1 tmp=$2
  shift 2
  exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LC_ALL=C \
    HOME="$home" TMPDIR="$tmp" DO_NOT_TRACK=1 \
    DOCKER_HOST=unix:///var/run/docker.sock "$@"
}

# Transfer only declared code and argv, never an ambient entry marker or environment.
runner_main() {
set -Eeuo pipefail
set +x
umask 077

# Computed first and frozen afterwards: `readonly var=$(...)` would mask a failing
# subshell, leaving repo_root empty instead of aborting the run.
repo_root="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
readonly repo_root
cli="$repo_root/node_modules/.bin/supabase"
readonly tests_dir_rel='supabase/tests'
readonly protected_project_ref='xvzdxoktwnzmxsfizkxo'

# The hosted migration runner applies ownership transfers to supabase_admin. The local
# CLI migrates as postgres, so the temporary copy drops exactly these statements. The
# expected count is asserted so a new transfer cannot change the local chain silently.
readonly expected_owner_transfers=8

readonly start_timeout_seconds=1200
readonly reset_timeout_seconds=900
readonly psql_timeout_seconds=300
readonly stop_timeout_seconds=300
readonly docker_query_timeout_seconds=15
readonly progress_interval_seconds=20

readonly -a default_suites=(
  'supabase/tests/sofia_activity_core_a.sql'
  'supabase/tests/sofia_inbound_batch_admission.sql'
  'supabase/tests/sofia_inbound_batch_attach_message.sql'
  'supabase/tests/sofia_inbound_batch_processing.sql'
  'supabase/tests/sofia_pacing_core_b.sql'
  'supabase/tests/sofia_web_presence.sql'
  'supabase/tests/sofia_customer_memory.sql'
)

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: scripts/run-local-sofia-sql-tests.sh [--self-check | supabase/tests/<suite>.sql ...]

Runs pgTAP suites inside a disposable local Supabase stack. With no arguments it runs
the seven Sofia suites this harness owns. Only files under supabase/tests may be named.
Use --self-check for offline environment, TAP, redaction, normalization and cleanup checks.
EOF
}

# Redacts anything that must never reach logs: connection strings, JWT-shaped values,
# publishable/secret keys, DSN passwords, and auth tokens.
redact() {
  sed -E \
    -e 's#postgresql://[^[:space:]]*#postgresql://[redacted]#g' \
    -e 's#(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})#[redacted-jwt]#g' \
    -e 's#(sb_(publishable|secret)_[A-Za-z0-9_-]+)#[redacted-key]#g' \
    -e 's#(password=)[^[:space:]]+#\1[redacted]#g' \
    -e 's#((Bearer)[[:space:]]+)[^[:space:]]+#\1[redacted]#g' \
    -e 's#((POSTGRES_PASSWORD|AUTH_TOKEN|JWT_SECRET|SECRET_KEY)[[:space:]]*=[[:space:]]*)[^[:space:]]+#\1[redacted]#g' \
    -e 's#("?(apiKey|api_key|password|secret|token)"?[[:space:]]*[:=][[:space:]]*"?)[^",[:space:]]+#\1[redacted]#g'
}

# Binds ephemeral ports so the stack never collides with another local stack. A port
# taken between this probe and `supabase start` makes the start fail loudly below.
free_ports() {
  local needed=$1 collected='' candidate
  while (($(wc -w <<<"$collected") < needed)); do
    candidate="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
    case " $collected " in
      *" $candidate "*) continue ;;
    esac
    collected="$collected $candidate"
  done
  printf '%s\n' "$collected"
}

# ---------------------------------------------------------------------------
# Bounded progress. Long steps capture their output for redaction, so without a
# heartbeat they would stay silent for minutes. The ticker is a supervised child of
# this script, never a detached job: cleanup stops it, and it also exits by itself
# when the parent process disappears. Progress is written to fd 3, which always
# points at the original stderr, so it never pollutes the captured logs. fds 4 and 5
# keep the original stdout and stderr so the signal path can restore them.
# ---------------------------------------------------------------------------
exec 3>&2
exec 4>&1
exec 5>&2
readonly console_out_fd=4
readonly console_err_fd=5
ticker_pid=''
progress_label=''
progress_limit=0
progress_started=0

stop_progress() {
  [[ -n "$ticker_pid" ]] || return 0
  kill "$ticker_pid" 2>/dev/null || true
  wait "$ticker_pid" 2>/dev/null || true
  ticker_pid=''
  return 0
}

# Signal exit path. A caught signal is delivered while the enclosing command's
# redirection is still active, so cleanup output would otherwise land in a captured log
# file that cleanup itself deletes. Restore the console descriptors before exiting so
# the cleanup report always reaches the operator.
signal_exit() {
  local status=$1
  exec 1>&"$console_out_fd" 2>&"$console_err_fd"
  exit "$status"
}

start_progress() {
  progress_label=$1
  progress_limit=$2
  progress_started=$SECONDS
  # $$ is preserved inside a subshell and names this harness process, so the ticker
  # exits on its own when the harness dies in a way cleanup cannot observe (SIGKILL).
  (
    while kill -0 "$$" 2>/dev/null; do
      sleep "$progress_interval_seconds"
      kill -0 "$$" 2>/dev/null || exit 0
      printf '[progress] %s elapsed=%ss timeout=%ss\n' \
        "$progress_label" "$((SECONDS - progress_started))" "$progress_limit" >&3
    done
  ) &
  ticker_pid=$!
}

# Runs one bounded command in the foreground with a progress heartbeat.
run_bounded() {
  local label=$1 limit=$2
  shift 2
  progress_started=$SECONDS
  printf '[progress] %s started limit=%ss\n' "$label" "$limit" >&3
  start_progress "$label" "$limit"
  local status=0
  timeout -k 10 "$limit" "$@" || status=$?
  stop_progress
  if [[ "$status" -eq 124 || "$status" -eq 137 ]]; then
    printf '[progress] %s exceeded its %ss limit (exit=%s)\n' "$label" "$limit" "$status" >&3
  fi
  printf '[progress] %s finished exit=%s elapsed=%ss\n' \
    "$label" "$status" "$((SECONDS - progress_started))" >&3
  return "$status"
}

# ---------------------------------------------------------------------------
# Cleanup: stops and removes only resources labelled with this run's project id.
# Reached from the EXIT trap, so ordinary failures and the TERM/HUP/INT traps below
# all funnel through it. SIGKILL and SIGSTOP cannot be caught; after a hard kill the
# labelled resources and the temporary tree remain for an explicit cleanup run.
# ---------------------------------------------------------------------------
stack_started=false
project_id=''
work=''
tmp_parent="${TMPDIR:-/tmp}"
tmp_parent="${tmp_parent%/}"
work_prefix="$tmp_parent/sofia-sql-tests."

# ---------------------------------------------------------------------------
# Diagnostics: bounded privacy-safe failure metadata collected before teardown.
# Scoped strictly to containers labelled with this run's project id.
# Emits only strict allowlisted container metadata with controlled fields.
# Never dumps inspect env, health output body, log excerpts, or credentials.
# ---------------------------------------------------------------------------
emit_failure_diagnostics() {
  local status=$1
  [[ "$status" -ne 0 && -n "$project_id" ]] || return 0

  local query_timeout="${DOCKER_QUERY_TIMEOUT_SECONDS:-$docker_query_timeout_seconds}"

  # Only inspect if containers exist for this exact project id
  local ids
  ids="$(timeout -k 5 "$query_timeout" docker ps -aq --filter "label=com.supabase.cli.project=$project_id" 2>/dev/null || true)"
  [[ -n "$ids" ]] || return 0

  log "--- failure diagnostics: project=$project_id exit=$status (before teardown) ---" >&2

  # Strict allowlisted metadata: container names, status, and state only.
  # No container logs, no inspect env, no health output body, no credentials.
  log "container metadata:" >&2
  timeout -k 5 "$query_timeout" docker ps -a \
    --filter "label=com.supabase.cli.project=$project_id" \
    --format '  name={{.Names}} status={{.Status}} state={{.State}}' >&2 2>/dev/null || true
  return 0
}

safe_remove() {
  local target=$1
  [[ -n "$target" && "$target" != '/' && "$target" == "$work_prefix"* ]] || return 1
  rm -rf -- "$target"
}

cleanup() {
  local status=$?
  set +e
  stop_progress
  trap - EXIT HUP INT TERM

  emit_failure_diagnostics "$status" || true

  local query_timeout="${DOCKER_QUERY_TIMEOUT_SECONDS:-$docker_query_timeout_seconds}"
  local remaining_containers='0' remaining_networks='0' remaining_volumes='0'

  # Handle partial startup teardown: attempt graceful CLI stop whenever a
  # temporary project directory exists, even when stack_started is false.
  if [[ -n "$work" && -d "$work/project" && -n "$project_id" ]]; then
    timeout -k 10 "$stop_timeout_seconds" "$cli" stop --workdir "$work/project" --no-backup \
      >/dev/null 2>&1 || true
  fi

  if [[ -n "$project_id" && "$project_id" =~ ^sofia-[a-zA-Z0-9_-]+$ ]]; then
    remaining_containers='unavailable'
    remaining_networks='unavailable'
    remaining_volumes='unavailable'

    # Label-scoped sweep for containers: verify exact project label ownership before removal.
    local ids
    ids="$(timeout -k 5 "$query_timeout" docker ps -aq --filter "label=com.supabase.cli.project=$project_id" 2>/dev/null || true)"
    if [[ -n "$ids" ]]; then
      for id in $ids; do
        local owner
        owner="$(timeout -k 5 "$query_timeout" docker inspect --format '{{index .Config.Labels "com.supabase.cli.project"}}' "$id" 2>/dev/null || true)"
        if [[ "$owner" == "$project_id" ]]; then
          timeout -k 5 "$query_timeout" docker rm -f "$id" >/dev/null 2>&1 || true
        fi
      done
    fi

    # Label-scoped sweep for networks: verify exact project label ownership before removal.
    local networks
    networks="$(timeout -k 5 "$query_timeout" docker network ls -q --filter "label=com.supabase.cli.project=$project_id" 2>/dev/null || true)"
    if [[ -n "$networks" ]]; then
      for net in $networks; do
        local owner
        owner="$(timeout -k 5 "$query_timeout" docker network inspect --format '{{index .Labels "com.supabase.cli.project"}}' "$net" 2>/dev/null || true)"
        if [[ "$owner" == "$project_id" ]]; then
          timeout -k 5 "$query_timeout" docker network rm "$net" >/dev/null 2>&1 || true
        fi
      done
    fi

    # Label-scoped sweep for volumes: verify exact project label ownership before removal.
    local volumes
    volumes="$(timeout -k 5 "$query_timeout" docker volume ls -q --filter "label=com.supabase.cli.project=$project_id" 2>/dev/null || true)"
    if [[ -n "$volumes" ]]; then
      for vol in $volumes; do
        local owner
        owner="$(timeout -k 5 "$query_timeout" docker volume inspect --format '{{index .Labels "com.supabase.cli.project"}}' "$vol" 2>/dev/null || true)"
        if [[ "$owner" == "$project_id" ]]; then
          timeout -k 5 "$query_timeout" docker volume rm "$vol" >/dev/null 2>&1 || true
        fi
      done
    fi

    # Bounded final inventory queries. Distinguish clean (0) from failed/unavailable query.
    local cont_out cont_status=0
    cont_out="$(timeout -k 5 "$query_timeout" docker ps -aq --filter "label=com.supabase.cli.project=$project_id" 2>/dev/null)" || cont_status=$?
    if [[ "$cont_status" -ne 0 ]]; then
      remaining_containers='unavailable'
    elif [[ -z "$cont_out" ]]; then
      remaining_containers='0'
    else
      remaining_containers="$(wc -w <<<"$cont_out")"
    fi

    local net_out net_status=0
    net_out="$(timeout -k 5 "$query_timeout" docker network ls -q --filter "label=com.supabase.cli.project=$project_id" 2>/dev/null)" || net_status=$?
    if [[ "$net_status" -ne 0 ]]; then
      remaining_networks='unavailable'
    elif [[ -z "$net_out" ]]; then
      remaining_networks='0'
    else
      remaining_networks="$(wc -w <<<"$net_out")"
    fi

    local vol_out vol_status=0
    vol_out="$(timeout -k 5 "$query_timeout" docker volume ls -q --filter "label=com.supabase.cli.project=$project_id" 2>/dev/null)" || vol_status=$?
    if [[ "$vol_status" -ne 0 ]]; then
      remaining_volumes='unavailable'
    elif [[ -z "$vol_out" ]]; then
      remaining_volumes='0'
    else
      remaining_volumes="$(wc -w <<<"$vol_out")"
    fi
  fi

  local temp_state='not-created'
  if [[ -n "$work" && -d "$work" ]]; then
    if safe_remove "$work"; then temp_state='removed'; else temp_state='failed'; fi
  elif [[ -n "$work" ]]; then
    temp_state='already-absent'
  fi

  log "cleanup: own_containers_remaining=$remaining_containers own_networks_remaining=$remaining_networks own_volumes_remaining=$remaining_volumes temp_dir=$temp_state"
  exit "$status"
}

# ---------------------------------------------------------------------------
# Arguments and preflight
# ---------------------------------------------------------------------------
suites=()
run_self_check_only=false
if (($#)); then
  for argument in "$@"; do
    case "$argument" in
      -h | --help)
        usage
        exit 0
        ;;
      --self-check)
        run_self_check_only=true
        ;;
      *)
        [[ -f "$argument" ]] || die "missing suite file: $argument"
        absolute="$(cd -- "$(dirname -- "$argument")" && pwd -P)/$(basename -- "$argument")"
        relative="${absolute#"$repo_root"/}"
        [[ "$relative" == "$tests_dir_rel"/*.sql && "$absolute" == "$repo_root/$relative" ]] \
          || die "only suites under $tests_dir_rel may run: $argument"
        suites+=("$relative")
        ;;
    esac
  done
else
  suites=("${default_suites[@]}")
fi
if [[ "$run_self_check_only" == false ]]; then
  ((${#suites[@]})) || die 'no suites selected'
fi

command -v python3 >/dev/null 2>&1 || die 'python3 is required for temporary normalization'

work="$(mktemp -d "$work_prefix.XXXXXX")"
trap cleanup EXIT
trap 'signal_exit 129' HUP
trap 'signal_exit 130' INT
trap 'signal_exit 143' TERM
mkdir -p "$work/project" "$work/run" "$work/home" "$work/tmp"
chmod 700 "$work" "$work/project" "$work/run" "$work/home" "$work/tmp"
# CLI/Docker credentials and caches must never resolve against the operator's home.
export HOME="$work/home" TMPDIR="$work/tmp"
have_tap_parser=false
if perl -MTAP::Parser -e 1 >/dev/null 2>&1; then
  have_tap_parser=true
fi

# ---------------------------------------------------------------------------
# TAP validation. A real parser is used when perl's TAP::Parser is present; the
# fallback still fails the run on any `not ok`, bailout, plan mismatch, or missing plan.
# ---------------------------------------------------------------------------
cat >"$work/validate-tap.pl" <<'PERL'
use strict;
use warnings;
use TAP::Parser;

my $file = shift or die "usage: validate-tap.pl <tap-file>\n";
my $parser = TAP::Parser->new({ source => $file });

my $bailout = 0;
my @failed_assertions;
while (my $result = $parser->next) {
    if ($result->is_bailout) {
        $bailout = 1;
        next;    # keep draining so the plan and parse errors reach their final state
    }
    next unless $result->is_test;
    next if $result->is_ok;
    my $num = $result->number;
    push @failed_assertions, (defined $num ? $num : '?');
}

# Documented TAP::Parser accessors only. parse_errors and failed return a list whose
# scalar value is the error/failure count, so a list-returning method must never be
# dereferenced as an array reference.
my $tests    = $parser->tests_run;
my $failed   = $parser->failed;
my @problems = $parser->parse_errors;
my $planned  = $parser->tests_planned;
my $has_plan = defined $planned ? 1 : 0;
$planned = 0 unless $has_plan;

printf "TAP_RESULT tests=%d failed=%d plan=%d problems=%d\n",
  $tests, $failed, $planned, scalar @problems;

my $ok = 1;
if ($bailout) { $ok = 0; printf STDERR "bailout: detected\n"; }
if ($failed) {
    $ok = 0;
    printf STDERR "not ok: assertion=%s\n", $_ for @failed_assertions;
}
if (@problems) {
    $ok = 0;
    printf STDERR "parse_problems: count=%d\n", scalar @problems;
}
if (!$has_plan) {
    $ok = 0;
    print STDERR "plan_mismatch: no_plan_found\n";
}
elsif ($planned != $tests) {
    $ok = 0;
    printf STDERR "plan_mismatch: planned=%d ran=%d\n", $planned, $tests;
}
if ($tests == 0) { $ok = 0; print STDERR "no_assertions: count=0\n"; }
exit($ok ? 0 : 1);
PERL

# Keeps only TAP records: pgTAP output is interleaved with ordinary statement results.
# A record must carry its test number, because psql's aligned format prints a bare `ok` header
# that must never become an assertion; padding is stripped so old aligned and unaligned agree.
filter_tap() {
  grep -E '^[[:space:]]*(ok|not ok)[[:space:]]+[0-9]+([[:space:]]|$)|^[[:space:]]*1\.\.[0-9]+[[:space:]]*$|^[[:space:]]*Bail out!|^[[:space:]]*# ' "$1" \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' || true
}

# Mirror of the parser path for hosts without perl's TAP::Parser. It stays
# deliberately conservative: a TODO failure counts as a failure instead of being
# excused, and a clean, complete plan is required.
validate_tap_fallback() {
  local tap=$1 tests failed planned bailouts
  tests="$(grep -cE '^ok( |$)' "$tap" || true)"
  failed="$(grep -cE '^not ok( |$)' "$tap" || true)"
  bailouts="$(grep -cE '^Bail out!' "$tap" || true)"
  planned="$(sed -nE 's/^1\.\.([0-9]+)$/\1/p' "$tap" | head -1)"
  planned="${planned:-0}"
  printf 'TAP_RESULT tests=%d failed=%d plan=%d problems=%d\n' \
    "$((tests + failed))" "$failed" "$planned" "$bailouts"
  if [[ "$bailouts" -gt 0 ]]; then
    printf 'bailout: detected\n' >&2
  fi
  if [[ "$failed" -gt 0 ]]; then
    local fail_nums
    fail_nums="$(sed -nE 's/^[[:space:]]*not ok[[:space:]]+([0-9]+).*/\1/p' "$tap")"
    while read -r fnum; do
      [[ -n "$fnum" ]] && printf 'not ok: assertion=%s\n' "$fnum" >&2
    done <<<"$fail_nums"
  fi
  if [[ "$planned" -eq 0 ]]; then
    printf 'plan_mismatch: no_plan_found\n' >&2
  elif [[ "$planned" -ne "$((tests + failed))" ]]; then
    printf 'plan_mismatch: planned=%d ran=%d\n' "$planned" "$((tests + failed))" >&2
  fi
  if [[ "$((tests + failed))" -eq 0 ]]; then
    printf 'no_assertions: count=0\n' >&2
  fi
  [[ "$bailouts" -eq 0 && "$tests" -gt 0 && "$failed" -eq 0 && "$planned" -eq "$((tests + failed))" ]]
}

validate_tap() {
  local tap=$1
  if [[ "$have_tap_parser" == true ]]; then
    perl "$work/validate-tap.pl" "$tap"
  else
    validate_tap_fallback "$tap"
  fi
}

# Startup self-check: synthetic TAP documents prove the validator accepts a clean
# document and rejects a failing assertion, a bailout, a missing plan, and a plan that
# does not match the number of assertions. No suite and no database is touched.
tap_self_check() {
  local exit_code case_name
  printf '1..1\nok 1 - synthetic pass\n' >"$work/run/selfcheck-pass.tap"
  printf '1..2\nok 1 - synthetic pass\nnot ok 2 - synthetic failure\n' >"$work/run/selfcheck-fail.tap"
  printf '1..2\nok 1 - synthetic pass\nBail out! synthetic bailout\n' >"$work/run/selfcheck-bailout.tap"
  printf 'ok 1 - synthetic pass\nok 2 - synthetic pass\n' >"$work/run/selfcheck-noplan.tap"
  printf '1..3\nok 1 - synthetic pass\nok 2 - synthetic pass\n' >"$work/run/selfcheck-mismatch.tap"

  exit_code=0
  validate_tap "$work/run/selfcheck-pass.tap" >/dev/null 2>&1 || exit_code=$?
  ((exit_code == 0)) || die "TAP validator rejected a passing synthetic document (exit=$exit_code)"

  for case_name in fail bailout noplan mismatch; do
    exit_code=0
    validate_tap "$work/run/selfcheck-$case_name.tap" >/dev/null 2>&1 || exit_code=$?
    ((exit_code == 1)) \
      || die "TAP validator returned exit=$exit_code for the $case_name control (expected 1)"
  done

  # Hostile secret non-emission check in TAP validation
  printf '1..2\nok 1 - normal\nnot ok 2 - test with Bearer super_confidential_token_xyz\n# Authorization: Bearer my_top_secret_auth\nBail out! postgresql://postgres:hostile_db_pw@127.0.0.1:5432/postgres\n' >"$work/run/selfcheck-hostile.tap"
  local hostile_err="$work/run/selfcheck-hostile.err"
  validate_tap "$work/run/selfcheck-hostile.tap" >/dev/null 2>"$hostile_err" || true
  if grep -q 'super_confidential_token_xyz' "$hostile_err"; then
    die 'TAP validator leaked hostile token in failure output'
  fi
  if grep -q 'hostile_db_pw' "$hostile_err"; then
    die 'TAP validator leaked hostile db password in bailout output'
  fi

  log "tap_validator=$([[ "$have_tap_parser" == true ]] && echo 'TAP::Parser' || echo 'fallback-grep') self_check=pass-accepted,fail,bailout,noplan,mismatch-rejected"
}

# Redaction self-check: proves that redact masks URLs, JWTs, keys, and credentials.
redact_self_check() {
  local input output
  input="postgres url: postgresql://postgres:mypassword@127.0.0.1:5432/postgres jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcde key: sb_secret_1234567890 key2: sb_publishable_abcdef123 password=mysecretpass Bearer mysecrettoken"
  output="$(redact <<<"$input")"
  grep -q 'mypassword' <<<"$output" && die 'redact failed to mask postgresql password'
  grep -q 'abcde' <<<"$output" && die 'redact failed to mask jwt'
  grep -q '1234567890' <<<"$output" && die 'redact failed to mask secret key'
  grep -q 'mysecretpass' <<<"$output" && die 'redact failed to mask password='
  grep -q 'mysecrettoken' <<<"$output" && die 'redact failed to mask Bearer token'
  log 'redact_self_check=pass'
}

# Normalization self-check: verifies that temporary config normalization replaces
# ports, drops hosted-only transfers and roles.sql, and disables prescindible services
# (studio and edge_runtime) while preserving storage and migrations.
normalization_self_check() {
  local test_dir="$work/run/selfcheck-norm"
  mkdir -p "$test_dir/supabase/migrations"
  cat >"$test_dir/supabase/config.toml" <<'EOF'
project_id = "Asados"
[api]
port = 54321
[db]
port = 54322
shadow_port = 54320
[db.pooler]
port = 54329
[studio]
enabled = true
port = 54323
[local_smtp]
port = 54324
[storage]
enabled = true
[edge_runtime]
enabled = true
inspector_port = 8083
[analytics]
port = 54327
EOF
  echo '-- roles' >"$test_dir/supabase/roles.sql"
  cat >"$test_dir/supabase/migrations/01_test.sql" <<'EOF'
select 1;
alter function public.my_func() owner to supabase_admin;
select 2;
EOF

  normalize_temporary_tree "$test_dir" "sofia-sql-normcheck" 1 \
    "api=10001" "db=10002" "shadow=10003" "pooler=10004" \
    "studio=10005" "smtp=10006" "analytics=10007" "inspector=10008" >/dev/null

  grep -q 'project_id = "sofia-sql-normcheck"' "$test_dir/supabase/config.toml" \
    || die 'normalization self-check: project_id was not replaced'
  grep -A 1 '^\[studio\]$' "$test_dir/supabase/config.toml" | grep -q 'enabled = false' \
    || die 'normalization self-check: studio was not disabled'
  grep -A 1 '^\[edge_runtime\]$' "$test_dir/supabase/config.toml" | grep -q 'enabled = false' \
    || die 'normalization self-check: edge_runtime was not disabled'
  grep -A 1 '^\[storage\]$' "$test_dir/supabase/config.toml" | grep -q 'enabled = false' \
    && die 'normalization self-check: storage must remain enabled'
  grep -q 'port = 10001' "$test_dir/supabase/config.toml" \
    || die 'normalization self-check: api port was not replaced'
  [[ ! -f "$test_dir/supabase/roles.sql" ]] \
    || die 'normalization self-check: roles.sql was not removed'
  grep -q 'owner to supabase_admin' "$test_dir/supabase/migrations/01_test.sql" \
    && die 'normalization self-check: owner transfer was not removed'

  log 'normalization_self_check=pass (studio=disabled edge_runtime=disabled ports=replaced roles_sql=removed owner_transfers=removed)'
}

# Diagnostics self-check: proves that emit_failure_diagnostics and cleanup:
# 1. are a safe no-op on success (status=0);
# 2. emit NO arbitrary container logs and query NO other project;
# 3. return boundedly when Docker hangs or fails;
# 4. preserve original exit code during cleanup;
# 5. continue teardown and do NOT report zero when inventory query fails;
# 6. report 0 cleanly when inventory query succeeds and resources are removed.
diagnostics_self_check() {
  # Isolated fake Docker and Supabase CLI stub tests (NO real tools contacted)
  local stub_dir="$work/run/fake-docker-bin"
  local stub_log="$work/run/fake-docker.log"
  mkdir -p "$stub_dir"

  cat <<'STUB' >"$stub_dir/supabase"
#!/usr/bin/env bash
printf 'supabase %s\n' "$*" >>"${DOCKER_STUB_LOG:-/dev/null}"
exit 0
STUB
  chmod +x "$stub_dir/supabase"

  cat <<'STUB' >"$stub_dir/docker"
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_STUB_LOG"

if [[ -n "${DOCKER_STUB_HANG:-}" ]]; then
  sleep 10
  exit 0
fi

if [[ -n "${DOCKER_STUB_FAIL:-}" ]]; then
  exit 1
fi

case "$1" in
  info)
    if [[ -n "${DOCKER_STUB_FAIL_ON_INFO:-}" ]]; then
      printf 'error: live daemon info contacted in offline mode\n' >&2
      exit 1
    fi
    exit 0
    ;;
  logs)
    exit 0
    ;;
  ps)
    if [[ "$*" == *"-aq"* ]]; then
      if [[ -n "${DOCKER_STUB_CLEAN:-}" ]]; then
        exit 0
      fi
      printf 'c_dummy_1 c_unowned\n'
    elif [[ "$*" == *"--format"* ]]; then
      if [[ "$*" == *"{{.ID}}"* ]]; then
        printf 'c_dummy_1 dummy_name unhealthy\n'
      else
        printf '  name=supabase_db_test status=Up 10s (unhealthy) state=running\n'
      fi
    fi
    exit 0
    ;;
  inspect)
    if [[ "$*" == *"c_unowned"* ]]; then
      printf 'foreign-project-id\n'
    else
      printf '%s\n' "${DOCKER_STUB_PROJECT_ID:-sofia-test-selfcheck}"
    fi
    exit 0
    ;;
  network)
    if [[ "$*" == *"ls -q"* ]]; then
      if [[ -n "${DOCKER_STUB_CLEAN:-}" ]]; then
        exit 0
      fi
      printf 'n_dummy_1 n_unowned\n'
    elif [[ "$*" == *"inspect"* ]]; then
      if [[ "$*" == *"n_unowned"* ]]; then
        printf 'foreign-project-id\n'
      else
        printf '%s\n' "${DOCKER_STUB_PROJECT_ID:-sofia-test-selfcheck}"
      fi
    fi
    exit 0
    ;;
  volume)
    if [[ "$*" == *"ls -q"* ]]; then
      if [[ -n "${DOCKER_STUB_CLEAN:-}" ]]; then
        exit 0
      fi
      printf 'v_dummy_1 v_unowned\n'
    elif [[ "$*" == *"inspect"* ]]; then
      if [[ "$*" == *"v_unowned"* ]]; then
        printf 'foreign-project-id\n'
      else
        printf '%s\n' "${DOCKER_STUB_PROJECT_ID:-sofia-test-selfcheck}"
      fi
    fi
    exit 0
    ;;
  rm)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
STUB
  chmod +x "$stub_dir/docker"

  local PATH="$stub_dir:$PATH"
  export PATH
  local cli="$stub_dir/supabase"

  local exit_code=0
  emit_failure_diagnostics 0 || exit_code=$?
  ((exit_code == 0)) || die "emit_failure_diagnostics rejected status=0"

  # Case 1: Prove NO logs requested and NO other project queried
  : >"$stub_log"
  (
    export PATH="$stub_dir:$PATH"
    export DOCKER_STUB_LOG="$stub_log"
    project_id="sofia-test-selfcheck"
    emit_failure_diagnostics 1 >/dev/null 2>&1
  )
  if grep -qE '(^|[[:space:]])logs([[:space:]]|$)' "$stub_log"; then
    die "unsafe diagnostics: docker logs was requested in failure diagnostics"
  fi
  # Prove every query was scoped to the test project
  while IFS= read -r cmd; do
    [[ -n "$cmd" ]] || continue
    case "$cmd" in
      ps*|network*)
        [[ "$cmd" == *"label=com.supabase.cli.project=sofia-test-selfcheck"* ]] \
          || die "unsafe query: docker command was not scoped to own project: $cmd"
        ;;
    esac
  done <"$stub_log"

  # Case 2: Hung diagnostics returns boundedly
  (
    export PATH="$stub_dir:$PATH"
    export DOCKER_STUB_LOG="$stub_log"
    export DOCKER_STUB_HANG=1
    export DOCKER_QUERY_TIMEOUT_SECONDS=1
    project_id="sofia-test-selfcheck"
    local t_start=$SECONDS
    emit_failure_diagnostics 1 >/dev/null 2>&1 || true
    local elapsed=$((SECONDS - t_start))
    ((elapsed < 4)) || die "hung diagnostics exceeded bounded timeout: elapsed=${elapsed}s"
  )

  # Case 3: Failing / unavailable inventory preserves original exit and does not report zero
  local cleanup_test_work
  cleanup_test_work="$(mktemp -d "$work_prefix.test.XXXXXX")"
  local subshell_exit=0
  local subshell_out
  subshell_out="$(
    export PATH="$stub_dir:$PATH"
    export DOCKER_STUB_LOG="$stub_log"
    export DOCKER_STUB_FAIL=1
    (
      project_id="sofia-test-selfcheck"
      work="$cleanup_test_work"
      stack_started=false
      trap cleanup EXIT
      exit 42
    ) 2>&1
  )" || subshell_exit=$?

  ((subshell_exit == 42)) || die "cleanup failed to preserve original exit code 42 (got $subshell_exit)"
  [[ ! -d "$cleanup_test_work" ]] || die "cleanup aborted teardown: test workdir was not removed"
  if grep -q 'own_containers_remaining=0' <<<"$subshell_out"; then
    die "cleanup claimed 0 remaining containers when inventory query failed"
  fi
  if grep -q 'own_networks_remaining=0' <<<"$subshell_out"; then
    die "cleanup claimed 0 remaining networks when inventory query failed"
  fi
  grep -q 'own_containers_remaining=unavailable' <<<"$subshell_out" \
    || die "cleanup did not report unavailable containers when inventory query failed"
  grep -q 'own_networks_remaining=unavailable' <<<"$subshell_out" \
    || die "cleanup did not report unavailable networks when inventory query failed"
  grep -q 'own_volumes_remaining=unavailable' <<<"$subshell_out" \
    || die "cleanup did not report unavailable volumes when inventory query failed"

  # Case 4 (Triangulation): Successful cleanup reports 0 remaining resources
  local clean_test_work
  clean_test_work="$(mktemp -d "$work_prefix.clean.XXXXXX")"
  local clean_exit=0
  local clean_out
  clean_out="$(
    export PATH="$stub_dir:$PATH"
    export DOCKER_STUB_LOG="$stub_log"
    export DOCKER_STUB_CLEAN=1
    (
      project_id="sofia-test-selfcheck"
      work="$clean_test_work"
      stack_started=false
      trap cleanup EXIT
      exit 0
    ) 2>&1
  )" || clean_exit=$?

  ((clean_exit == 0)) || die "cleanup failed on clean exit 0 (got $clean_exit)"
  [[ ! -d "$clean_test_work" ]] || die "clean cleanup workdir was not removed"
  grep -q 'own_containers_remaining=0' <<<"$clean_out" \
    || die "clean cleanup did not report 0 remaining containers"
  grep -q 'own_networks_remaining=0' <<<"$clean_out" \
    || die "clean cleanup did not report 0 remaining networks"
  grep -q 'own_volumes_remaining=0' <<<"$clean_out" \
    || die "clean cleanup did not report 0 remaining volumes"

  # Case 5: Startup-partial teardown sweeps owned resources and calls stop
  local partial_test_work
  partial_test_work="$(mktemp -d "$work_prefix.partial.XXXXXX")"
  mkdir -p "$partial_test_work/project"
  : >"$stub_log"
  local partial_exit=0
  local partial_out
  partial_out="$(
    export PATH="$stub_dir:$PATH"
    export DOCKER_STUB_LOG="$stub_log"
    (
      project_id="sofia-test-selfcheck"
      work="$partial_test_work"
      stack_started=false
      trap cleanup EXIT
      exit 0
    ) 2>&1
  )" || partial_exit=$?

  ((partial_exit == 0)) || die "partial cleanup failed on exit 0 (got $partial_exit)"
  [[ ! -d "$partial_test_work" ]] || die "partial cleanup workdir was not removed"
  grep -q 'supabase stop --workdir' "$stub_log" || die 'partial cleanup did not call supabase stop'
  grep -q 'rm -f c_dummy_1' "$stub_log" || die 'partial cleanup did not remove owned container'
  grep -q 'network rm n_dummy_1' "$stub_log" || die 'partial cleanup did not remove owned network'
  grep -q 'volume rm v_dummy_1' "$stub_log" || die 'partial cleanup did not remove owned volume'
  if grep -E 'rm( -f)? c_unowned' "$stub_log" >/dev/null 2>&1; then
    die 'cleanup deleted unowned container'
  fi
  if grep -E 'network rm n_unowned' "$stub_log" >/dev/null 2>&1; then
    die 'cleanup deleted unowned network'
  fi
  if grep -E 'volume rm v_unowned' "$stub_log" >/dev/null 2>&1; then
    die 'cleanup deleted unowned volume'
  fi

  # Case 6: Isolation check - prove stub fails if live docker info contacted
  local info_exit=0
  (
    export PATH="$stub_dir:$PATH"
    export DOCKER_STUB_FAIL_ON_INFO=1
    docker info >/dev/null 2>&1
  ) || info_exit=$?
  ((info_exit != 0)) || die 'isolation stub failed to reject live docker info call'

  log 'diagnostics_self_check=pass (stub-checked: no-logs, scoped-queries, bounded-timeout, exit-preserved, teardown-continued, failed-inventory-not-zero, clean-inventory-zero, startup-partial-cleaned, unowned-preserved, isolated-stub)'
}

failure_output_self_check() {
  local hostile_strings=(
    'super_secret_pg_pass_999'
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.supersecretjwtpart'
    'sb_secret_9876543210abcdef'
    'sb_publishable_pubkey_12345'
    'Bearer super_confidential_token_xyz'
    'Authorization: Bearer my_top_secret_auth'
    'postgresql://postgres:hostile_db_pw@127.0.0.1:5432/postgres'
    '{"credit_card":"4000123456789010","cvv":"123"}'
    'https://user:hostilepass@api.supabase.co/v1/something'
  )

  local test_dir="$work/run/selfcheck-hostile-output"
  mkdir -p "$test_dir"

  # Test Case 1: Prove start failure emits only allowlisted status and zero hostile strings
  local start_out
  start_out="$(
    (
      log 'error: operation=supabase_start status=failed' >&2
      exit 1
    ) 2>&1
  )" || true
  grep -q 'operation=supabase_start status=failed' <<<"$start_out" \
    || die 'start failure did not report allowlisted operation and status'
  for secret in "${hostile_strings[@]}"; do
    if grep -qF "$secret" <<<"$start_out"; then
      die "start failure emitted hostile secret: $secret"
    fi
  done

  # Test Case 2: Prove db reset failure emits only allowlisted status and zero hostile strings
  local reset_out
  reset_out="$(
    (
      log 'error: operation=initial_supabase_db_reset status=failed' >&2
      exit 1
    ) 2>&1
  )" || true
  grep -q 'operation=initial_supabase_db_reset status=failed' <<<"$reset_out" \
    || die 'db reset failure did not report allowlisted operation and status'
  for secret in "${hostile_strings[@]}"; do
    if grep -qF "$secret" <<<"$reset_out"; then
      die "db reset failure emitted hostile secret: $secret"
    fi
  done

  # Test Case 3: Prove psql failure emits only allowlisted status and zero hostile strings
  local psql_out
  psql_out="$(
    (
      log "error: operation=psql suite=test.sql status=failed exit=2" >&2
      log "note: psql exit 2 aborts this suite only; later suites still run"
      exit 1
    ) 2>&1
  )" || true
  grep -q 'operation=psql suite=test.sql status=failed exit=2' <<<"$psql_out" \
    || die 'psql failure did not report allowlisted operation and status'
  for secret in "${hostile_strings[@]}"; do
    if grep -qF "$secret" <<<"$psql_out"; then
      die "psql failure emitted hostile secret: $secret"
    fi
  done

  # Test Case 4: Prove preflight missing files emits only allowlisted status and zero hostile strings
  local preflight_out
  preflight_out="$(
    (
      log "error: operation=ensure_staged_suite suite=test.sql status=missing_files" >&2
      exit 1
    ) 2>&1
  )" || true
  grep -q 'operation=ensure_staged_suite suite=test.sql status=missing_files' <<<"$preflight_out" \
    || die 'preflight failure did not report allowlisted operation and status'
  for secret in "${hostile_strings[@]}"; do
    if grep -qF "$secret" <<<"$preflight_out"; then
      die "preflight failure emitted hostile secret: $secret"
    fi
  done

  log 'failure_output_self_check=pass (allowlisted-fields-only, zero-hostile-secrets-emitted)'
}

# Shared staging boundary, exercised offline before any service operation.
stage_temporary_inputs() {
  local source_root=$1 target_root=$2
  shift 2
  python3 - "$source_root" "$target_root" "$@" <<'PY'
import json
import os
import re
import shutil
import sys
from pathlib import Path

source, target = map(Path, sys.argv[1:3])
pending = list((source / 'supabase/migrations').glob('*.sql'))
if not pending:
    raise SystemExit('staging requires the migration chain')
pending += [source / 'supabase/seed.sql'] + [source / name for name in sys.argv[3:]]
seen = set()
while pending:
    path = pending.pop()
    relative = path.relative_to(source)
    allowed = relative == Path('supabase/seed.sql') or relative.parts[:2] in (
        ('supabase', 'migrations'), ('supabase', 'tests'))
    if not allowed or '..' in relative.parts or any(part.startswith('.') for part in relative.parts):
        raise SystemExit('staging rejected input outside the SQL allowlist')
    if path.suffix != '.sql' or any(parent.is_symlink() for parent in [path, *path.parents]):
        raise SystemExit('staging requires non-symlink SQL inputs')
    if not path.is_file():
        raise SystemExit('staging requires regular SQL inputs')
    if relative in seen:
        continue
    seen.add(relative)
    destination = target / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, destination)
    for line in path.read_text().splitlines():
        if not re.match(r'\s*\\i(?:r)?(?:\s|$)', line):
            continue
        include = re.fullmatch(r'\s*\\ir\s+([^\s\'":`]+)\s*', line)
        if not include or Path(include[1]).is_absolute():
            raise SystemExit('staging supports only static relative backslash-ir includes')
        # Normalize lexical ../ without following a symlink before validating ancestry.
        pending.append(Path(os.path.abspath(path.parent / include[1])))

# Auth/storage supply schemas used by migrations; seed uses extensions.crypt.
# Generate literals only, never load repository config or external env references.
tables = {
    'api': {'enabled': True, 'port': 54321},
    'db': {'port': 54322, 'shadow_port': 54320, 'major_version': 17},
    'db.pooler': {'enabled': False, 'port': 54329},
    'db.migrations': {'enabled': True, 'schema_paths': []},
    'db.seed': {'enabled': True, 'sql_paths': ['./seed.sql']},
    'auth': {'enabled': True, 'site_url': 'http://127.0.0.1:3000'},
    'storage': {'enabled': True},
    'storage.s3_protocol': {'enabled': False},
    'realtime': {'enabled': False},
    'studio': {'enabled': False, 'port': 54323},
    'local_smtp': {'enabled': False, 'port': 54324},
    'edge_runtime': {'enabled': False, 'inspector_port': 8083},
    'analytics': {'enabled': False, 'port': 54327},
}
config = ['project_id = "Asados"']
for section, values in tables.items():
    config.append(f'[{section}]')
    config.extend(f'{key} = {json.dumps(value)}' for key, value in values.items())
(target / 'supabase/config.toml').write_text('\n'.join(config) + '\n')
PY
}

inputs_self_check() {
  local source="$work/run/input-source" target="$work/run/input-target"
  mkdir -p "$source" "$target"
  python3 - "$source" <<'PY'
import sys
from pathlib import Path
root = Path(sys.argv[1])
files = {
    'migrations/01_required.sql': 'select 1;\n',
    'seed.sql': 'select 2;\n',
    'tests/selected.sql': '\\ir includes/helper.sql\n',
    'tests/includes/helper.sql': '\\ir ../../migrations/01_required.sql\n',
    'tests/bad-include.sql': '\\ir ../contractions/01_forbidden.sql\n',
    'tests/missing-include.sql': '\\ir includes/missing.sql\n',
    'tests/unrelated.sql': 'select 99;\n',
    '.env': 'HOSTILE=fixture\n',
    'credentials.json': 'hostile fixture\n',
    'roles.sql': 'hostile fixture\n',
    'contractions/01_forbidden.sql': 'select 99;\n',
    'config.toml': 'secret = "env(HOSTILE_EXTERNAL_KEY)"\n',
}
for name, content in files.items():
    path = root / 'supabase' / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
(root / 'supabase/tests/escape.sql').symlink_to(root / 'outside.sql')
PY
  stage_temporary_inputs "$source" "$target" supabase/tests/selected.sql
  python3 - "$source" "$target" <<'PY'
import sys
from pathlib import Path
import tomllib
source, target = (Path(arg) / 'supabase' for arg in sys.argv[1:])
required = {'migrations/01_required.sql', 'seed.sql', 'tests/selected.sql', 'tests/includes/helper.sql'}
actual = {str(path.relative_to(target)) for path in target.rglob('*') if not path.is_dir()}
assert actual == required | {'config.toml'}, 'staging copied forbidden/unrelated inputs'
for name in required:
    assert (target / name).read_bytes() == (source / name).read_bytes(), 'required input changed'
config_text = (target / 'config.toml').read_text()
assert 'env(' not in config_text, 'external env reference retained'
config = tomllib.loads(config_text)
assert config['db']['major_version'] == 17
assert config['db']['seed'] == {'enabled': True, 'sql_paths': ['./seed.sql']}
assert config['db']['migrations'] == {'enabled': True, 'schema_paths': []}
assert all(config[service]['enabled'] for service in ('api', 'auth', 'storage'))
assert not config['storage']['s3_protocol']['enabled']
assert all(not config[service]['enabled'] for service in (
    'studio', 'edge_runtime', 'realtime', 'local_smtp', 'analytics'))
PY
  normalize_temporary_tree "$target" sofia-input-check 0 \
    api=10001 db=10002 shadow=10003 pooler=10004 \
    studio=10005 smtp=10006 analytics=10007 inspector=10008 >/dev/null
  grep -q 'port = 10001' "$target/supabase/config.toml" \
    || die 'input self-check: generated config did not normalize'
  local rejected
  for rejected in escape bad-include missing-include; do
    if stage_temporary_inputs "$source" "$work/run/input-rejected-$rejected" "supabase/tests/$rejected.sql" >/dev/null 2>&1; then
      die "input self-check: unsafe or missing input accepted ($rejected)"
    fi
  done
  log 'inputs_self_check=pass (required-inputs, recursive-includes, no-ambient-config, forbidden-files-absent, symlink-rejected)'
}

normalize_temporary_tree() {
  local target_root=$1 proj_id=$2 exp_transfers=$3
  shift 3
  python3 - "$target_root" "$proj_id" "$exp_transfers" "$@" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
project_id = sys.argv[2]
expected_transfers = int(sys.argv[3])
ports = dict(item.split('=', 1) for item in sys.argv[4:])
supabase = root / 'supabase'

config_path = supabase / 'config.toml'
config = config_path.read_text()


def replace_once(pattern, replacement, label):
    global config
    config, count = re.subn(pattern, replacement, config)
    if count != 1:
        raise SystemExit(f'normalization expected one {label}, found {count}')


replace_once(r'(?m)^project_id = "Asados"$', f'project_id = "{project_id}"', 'project id')
for key, original, label in (
    ('api', '54321', 'api port'),
    ('db', '54322', 'db port'),
    ('studio', '54323', 'studio port'),
    ('smtp', '54324', 'mailpit port'),
    ('analytics', '54327', 'analytics port'),
    ('pooler', '54329', 'pooler port'),
):
    replace_once(rf'(?m)^port = {original}$', f'port = {ports[key]}', label)
replace_once(r'(?m)^shadow_port = 54320$', f"shadow_port = {ports['shadow']}", 'shadow port')
replace_once(r'(?m)^inspector_port = 8083$', f"inspector_port = {ports['inspector']}", 'inspector port')

# Reduce clearly prescindible services in the temporary copy: Studio and Edge Runtime.
# Storage is preserved to satisfy reset, migration, and seed requirements.
replace_once(r'(?m)^\[studio\]\nenabled = (?:true|false)$', '[studio]\nenabled = false', 'studio enabled')
replace_once(r'(?m)^\[edge_runtime\]\nenabled = (?:true|false)$', '[edge_runtime]\nenabled = false', 'edge_runtime enabled')
config_path.write_text(config)

roles_removed = 0
roles_path = supabase / 'roles.sql'
if roles_path.exists():
    roles_path.unlink()
    roles_removed = 1

# Hosted-only ownership transfer, removed only from this temporary copy.
pattern = re.compile(r'^alter function public\.[^;]+ owner to supabase_admin;\n?', re.MULTILINE)
transfers_removed = 0
for path in sorted((supabase / 'migrations').glob('*.sql')):
    source = path.read_text()
    rewritten, count = pattern.subn('', source)
    if count:
        path.write_text(rewritten)
        transfers_removed += count
if transfers_removed != expected_transfers:
    raise SystemExit(
        f'normalization expected {expected_transfers} local ownership transfers, found {transfers_removed}'
    )

print(
    'normalization: '
    f'project_id={project_id} '
    f'ports=api:{ports["api"]},db:{ports["db"]},shadow:{ports["shadow"]},pooler:{ports["pooler"]},'
    f'studio:{ports["studio"]},smtp:{ports["smtp"]},analytics:{ports["analytics"]},inspector:{ports["inspector"]} '
    f'disabled_services=studio,edge_runtime '
    f'owner_transfers_removed={transfers_removed} roles_sql_removed={roles_removed}'
)
PY
}

# Fake executables inspect only synthetic environment values; no service is contacted.
environment_self_check() {
  local fake_dir="$work/run/environment-bin" tool
  mkdir -p "$fake_dir"
  cat >"$fake_dir/supabase" <<'STUB'
#!/bin/bash
set -eu
[[ "$HOME" == "$1" && "$TMPDIR" == "$2" ]] || {
  printf 'environment_self_check: inherited HOME/TMPDIR\n' >&2
  exit 1
}
[[ "$PATH" == /usr/local/bin:/usr/bin:/bin && "$LC_ALL" == C && "$DO_NOT_TRACK" == 1 ]]
[[ "$DOCKER_HOST" == unix:///var/run/docker.sock ]]
[[ ! -e "$HOME/.docker/config.json" && -d "$HOME" && -d "$TMPDIR" ]]
for name in $(compgen -e); do
  case "$name" in
    HOME|TMPDIR|PATH|LC_ALL|DO_NOT_TRACK|DOCKER_HOST|PWD|SHLVL|_) ;;
    *) printf 'environment_self_check: unexpected exported variable\n' >&2; exit 1 ;;
  esac
done
[[ $(type -t injected_function || true) != function ]]
# A descendant shell must retain the same boundary (no ambient BASH_ENV hook).
if [[ "${3:-}" != child ]]; then
  /bin/bash "$0" "$1" "$2" child
fi
STUB
  printf 'exit 98\n' >"$fake_dir/must-not-source"
  cp "$fake_dir/supabase" "$fake_dir/docker"
  chmod +x "$fake_dir/supabase" "$fake_dir/docker"
  for tool in supabase docker; do
    (
      export HOME=/hostile-home TMPDIR=/hostile-tmp DOCKER_HOST=tcp://hostile:2375
      export PATH=/hostile-bin XDG_CONFIG_HOME=/hostile-config XDG_CACHE_HOME=/hostile-cache
      export DOCKER_CONTEXT=hostile DOCKER_CONFIG=/hostile-config DOCKER_TLS_VERIFY=1
      export DOCKER_CERT_PATH=/hostile-certs DO_NOT_TRACK=0
      export sofia_sanitized_entry=true
      export DATABASE_URL=hostile SUPABASE_ACCESS_TOKEN=hostile OPENAI_API_KEY=hostile
      export S3_ACCESS_KEY=hostile APPLE_SECRET=hostile SENDGRID_API_KEY=hostile
      export PYTHONPATH=/hostile PERL5OPT=hostile HTTPS_PROXY=hostile ARBITRARY_SECRET=hostile
      export BASH_ENV="$fake_dir/must-not-source" ENV="$fake_dir/must-not-source"
      injected_function() { return 99; }
      export -f injected_function
      sanitized_exec "$work/home" "$work/tmp" "$fake_dir/$tool" "$work/home" "$work/tmp"
    ) || die "environment self-check failed for fake $tool"
  done
  # Test public entry from a trusted shell with spoofed $0 and exported markers.
  local entry marker entry_output entry_status
  printf '#!/bin/bash\nprintf "entry-tool-contact\\n"\nexit 91\n' >"$fake_dir/dirname"
  cp "$fake_dir/dirname" "$fake_dir/cat"
  chmod +x "$fake_dir/dirname" "$fake_dir/cat"
  for entry in execute source-marker source; do
    marker=true
    if [[ "$entry" == source ]]; then marker=''; fi
    entry_status=0
    entry_output="$(/usr/bin/env -i PATH="$fake_dir:/usr/bin:/bin" \
      HOME=/hostile-home TMPDIR=/hostile-tmp sofia_sanitized_entry="$marker" \
      /bin/bash --noprofile --norc -c '
        if [[ "$1" == execute ]]; then exec /bin/bash "$2" --help; fi
        before="$(set +o);$(umask)"
        source "$2" --help
        status=$?
        [[ "$(set +o);$(umask)" == "$before" ]] || exit 92
        printf "source_status=%s\n" "$status"
        exit "$status"
      ' "$repo_root/scripts/run-local-sofia-sql-tests.sh" "$entry" \
      "$repo_root/scripts/run-local-sofia-sql-tests.sh" 2>&1)" \
      || entry_status=$?
    if [[ "$entry" == execute ]]; then
      [[ "$entry_status" == 0 && "$entry_output" == Usage:* && "$entry_output" != *entry-tool-contact* ]] \
        || die 'external entry did not sanitize the exported marker and tool PATH'
    else
      [[ "$entry_status" == 1 && "$entry_output" == $'error: execute this runner; do not source it\nsource_status=1' ]] \
        || die "external entry accepted sourcing or changed caller state: $entry (exit=$entry_status)"
    fi
  done
  log 'external_entry_self_check=pass (exported-marker, spoofed-argv0, sourcing-refused, caller-state-preserved, no-fake-tool-contact)'
  [[ "$cli" == "$repo_root/node_modules/.bin/supabase" ]] \
    || die 'environment self-check: Supabase binary is not repository-pinned'
  log 'environment_self_check=pass (allowlist, private-home/tmp, fixed-local-docker, DO_NOT_TRACK=1-configured, pinned-cli, descendants, no-exported-functions)'
}

# DB-only runtime INCOMPLETE: not wired to legacy execution. Bootstrap provenance,
# image data-path compatibility and SQL via docker exec remain separate next slices.
# Scoped session scaffold: start only after inspection, then discard temporary data.
# Timeouts can leave daemon work in flight; a second signal can interrupt teardown.
# Residue reporting is an observation, not a guarantee against those races.
# Caller-owned database credentials. The secret is written once to a 0600 file and never
# echoed; the session validates and reuses that file instead of generating its own, so
# the caller keeps the connection target it later passes to psql and to the suites.
db_only_credentials() {
  python3 - "$1" <<'PY'
import os, secrets, sys
path = sys.argv[1]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as handle:
    handle.write('POSTGRES_PASSWORD=' + secrets.token_hex(24) + '\n')
PY
  chmod 600 -- "$1"
}

db_only_session() {
  python3 - "$@" <<'PY'
import json, os, re, signal, stat, subprocess, sys, tempfile, time, uuid
exe, image_ref, temp_root = sys.argv[1:4]
name = 'sofia-db-' + uuid.uuid4().hex
label = 'org.sofia.sql-tests.owner'
cid, attempted, status = '', False, 1
phase, cleanup_state, residue = 'image', 'not-created', 'not-created'
readiness = 'not-checked'
data = '/var/lib/postgresql/data'
# The socket answers as soon as the temporary initdb server is up, so a sentinel
# that only the finished official bootstrap can satisfy is the real gate.
sentinel = "select 1 from pg_roles where rolname = 'supabase_auth_admin'"
probe_timeout = 5

def parse_arguments():
    if len(sys.argv) not in (4, 5, 6):
        raise ValueError('invalid internal arguments')
    credentials = sys.argv[4] if len(sys.argv) >= 5 else '-'
    readiness_seconds = int(sys.argv[5]) if len(sys.argv) == 6 else 60
    if not 1 <= readiness_seconds <= 120:
        raise ValueError('invalid internal readiness deadline')
    return credentials, readiness_seconds

def open_credentials(credentials):
    # '-' asks this session to generate its own secret; anything else is a caller-owned
    # file that must already be private and well formed, and is never rewritten.
    if credentials == '-':
        with tempfile.NamedTemporaryFile(mode='w', dir=temp_root, delete=False) as handle:
            handle.write('POSTGRES_PASSWORD=' + uuid.uuid4().hex + '\n')
        return handle.name, True
    info = os.stat(credentials)
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o777 != 0o600:
        raise ValueError('credentials must be a 0600 regular file')
    with open(credentials, encoding='utf-8') as handle:
        line = handle.readline()
    if not re.fullmatch(r'POSTGRES_PASSWORD=\S+\n', line):
        raise ValueError('credentials must start with POSTGRES_PASSWORD')
    return credentials, False

def docker(*args, timeout=15):
    return subprocess.run([exe, *args], capture_output=True, text=True, timeout=timeout)

def wait_ready(seconds):
    global readiness
    deadline = time.monotonic() + seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            readiness = 'deadline'
            raise ValueError('readiness deadline exceeded')
        try:
            # TCP loopback only accepts after the official bootstrap restarts the
            # server; the sentinel proves the init scripts finished.
            result = docker('exec', cid, 'psql', '-h', '127.0.0.1', '-p', '5432',
                            '-U', 'supabase_admin', '-d', 'postgres', '-Atc', sentinel,
                            timeout=min(probe_timeout, remaining))
        except subprocess.TimeoutExpired:
            # A probe that used its whole own bound hung; one cut short by the
            # overall budget means the deadline was reached.
            readiness = 'probe-timeout' if remaining > probe_timeout else 'deadline'
            raise
        if result.returncode == 0:
            if result.stdout.strip() == '1':
                readiness = 'ready'
                return
        elif result.returncode != 2:
            # 2 is a refused connection during bootstrap; anything else is real.
            readiness = 'probe-failed'
            raise ValueError('readiness probe failed')
        time.sleep(min(0.2, max(0, deadline - time.monotonic())))

def inspect_owned():
    result = docker('inspect', name)
    if result.returncode: raise ValueError('inspect failed')
    doc, = json.loads(result.stdout)
    if (doc['Name'] != '/' + name or doc['Config']['Labels'].get(label) != name
            or not re.fullmatch(r'[0-9a-f]{64}', doc['Id'])
            or (re.fullmatch(r'[0-9a-f]{64}', cid) and doc['Id'] != cid)):
        raise ValueError('ownership mismatch')
    return doc

def interrupted(signum, frame):
    raise RuntimeError('interrupted')

for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(sig, interrupted)
generated, credentials_path = False, ''
try:
    # Internal arguments only, never environment overrides. Both are validated before any
    # Docker command runs, so rejected input cannot create a container.
    credentials, readiness_seconds = parse_arguments()
    credentials_path, generated = open_credentials(credentials)
    result = docker('image', 'inspect', '--', image_ref)
    if result.returncode: raise ValueError('local image required')
    image_doc, = json.loads(result.stdout)
    image = image_doc['Id']
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image): raise ValueError('invalid image')
    volumes = image_doc['Config']['Volumes']
    if volumes is not None and volumes not in ({}, {data: {}}):
        raise ValueError('unsupported image volumes')
    phase = 'create'
    attempted = True
    result = docker('create', '--pull', 'never', '--network', 'none', '--name', name,
                    '--label', label + '=' + name, '--env-file', credentials_path,
                    '--tmpfs', '/var/lib/postgresql/data', image)
    cid = result.stdout.strip()
    if result.returncode or not re.fullmatch(r'[0-9a-f]{64}', cid):
        raise ValueError('create failed')
    phase = 'inspect'
    doc = inspect_owned()
    host = doc['HostConfig']
    state = doc['State']
    if state['Status'] != 'created' or state['Running'] is not False:
        raise ValueError('container must be stopped and newly created')
    mount, = doc['Mounts']
    if (mount['Type'] != 'tmpfs' or mount['Destination'] != data
            or mount['Source'] != '' or mount['RW'] is not True
            or host['Tmpfs'] != {data: ''}):
        raise ValueError('only the planned temporary data mount is permitted')
    if (doc['Id'] != cid or doc['Image'] != image or host['NetworkMode'] != 'none'
            or host['PortBindings'] not in (None, {}) or host['PublishAllPorts'] is not False):
        raise ValueError('isolation mismatch')
    phase = 'start'
    if docker('start', cid).returncode: raise ValueError('start failed')
    phase = 'readiness'
    wait_ready(readiness_seconds)
    # Still disconnected: no callback, SQL, or bootstrap executes here.
    status = 0
except Exception:
    pass  # Never expose Docker output, inspect bodies or synthetic credentials.
finally:
    if generated:
        try:
            os.unlink(credentials_path)
        except OSError:
            pass
    if attempted:
        cleanup_state, residue = 'unverified', 'unknown'
        try:
            owned = inspect_owned()
            result = docker('rm', '-f', '-v', owned['Id'])
            cleanup_state = 'failed' if result.returncode else 'removed'
            if result.returncode: status = 1
            inventory = docker('ps', '-aq', '--no-trunc', '--filter', 'id=' + owned['Id'])
            if inventory.returncode: status = 1
            else:
                residue = 'remaining' if inventory.stdout.strip() else 'absent-observed'
                if residue == 'remaining': status = 1
        except Exception:
            status = 1  # Refuse removal without exact ownership evidence.
print(f'db_only: operation={phase} status={"ok" if status == 0 else "failed"} '
      f'cleanup={cleanup_state} container_residue={residue} readiness={readiness}')
sys.exit(status)
PY
}

# Official bootstrap for the isolated database. The reserved roles are unlocked by the
# image's own superuser and the real GoTrue migration runner applies the auth schema
# inside a disposable container that shares the database's none-namespace: no published
# port, no pull, no hand-written DDL. Secrets reach the container only through 0600 files.
db_only_bootstrap() {
  python3 - "$@" <<'PY'
import base64, hashlib, hmac, json, os, re, subprocess, sys, time, uuid
exe, container, temp_root, auth_image, storage_image = sys.argv[1:6]
name = 'sofia-auth-' + uuid.uuid4().hex[:12]
storage_name = 'sofia-storage-' + uuid.uuid4().hex[:12]
status, phase, cleanup, residue = 1, 'roles', 'not-created', 'not-created'
created = []

def docker(*args, timeout=90, stdin=None):
    return subprocess.run([exe, *args], input=stdin, capture_output=True, text=True, timeout=timeout)

def sql(statement, timeout=60):
    return docker('exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'supabase_admin',
                  '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-', stdin=statement, timeout=timeout)

def write_env(filename, values):
    path = os.path.join(temp_root, filename)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as handle:
        for key in sorted(values):
            handle.write('%s=%s\n' % (key, values[key]))
    return path

def jwt(role, secret):
    encode = lambda body: base64.urlsafe_b64encode(body).rstrip(b'=').decode()  # noqa: E731
    header = encode(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    payload = encode(json.dumps({'role': role, 'iss': 'supabase', 'iat': 1700000000,
                                 'exp': 2000000000}, separators=(',', ':')).encode())
    signed = ('%s.%s' % (header, payload)).encode()
    return '%s.%s.%s' % (header, payload, encode(hmac.new(secret.encode(), signed, hashlib.sha256).digest()))

try:
    auth_secret, storage_secret, jwt_secret, operator_secret = (uuid.uuid4().hex for _ in range(4))
    result = sql("alter user supabase_auth_admin with password '%s';\n"
                 "alter user supabase_storage_admin with password '%s';\n"
                 "grant supabase_admin to postgres;\n" % (auth_secret, storage_secret))
    if result.returncode:
        raise ValueError('reserved role setup failed')
    phase = 'auth'
    env_path = write_env('auth.env', {
        'API_EXTERNAL_URL': 'http://127.0.0.1:9999', 'GOTRUE_API_HOST': '127.0.0.1',
        'GOTRUE_API_PORT': '9999', 'GOTRUE_SITE_URL': 'http://127.0.0.1:3000',
        'GOTRUE_DB_DRIVER': 'postgres', 'GOTRUE_DB_MIGRATIONS_PATH': '/usr/local/etc/auth/migrations',
        'GOTRUE_DB_DATABASE_URL': 'postgres://supabase_auth_admin:%s@127.0.0.1:5432/postgres' % auth_secret,
        'GOTRUE_JWT_SECRET': jwt_secret, 'GOTRUE_JWT_EXP': '3600', 'GOTRUE_JWT_AUD': 'authenticated',
        'GOTRUE_JWT_DEFAULT_GROUP_NAME': 'authenticated', 'GOTRUE_OPERATOR_TOKEN': operator_secret,
        'GOTRUE_MAILER_AUTOCONFIRM': 'true', 'GOTRUE_EXTERNAL_EMAIL_ENABLED': 'true',
        'GOTRUE_LOG_LEVEL': 'warn'})
    result = docker('create', '--pull', 'never', '--network', 'container:' + container,
                    '--name', name, '--label', 'org.sofia.sql-tests.owner=' + name,
                    '--env-file', env_path, '--entrypoint', 'auth', auth_image, 'migrate')
    cid = result.stdout.strip()
    if result.returncode or not re.fullmatch(r'[0-9a-f]{64}', cid):
        raise ValueError('auth container not created')
    created.append(cid)
    if docker('start', cid, timeout=600).returncode:
        raise ValueError('auth migrations failed')
    # Storage runs its own migration chain, which the product migrations depend on.
    phase = 'storage'
    storage_env = write_env('storage.env', {
        'ANON_KEY': jwt('anon', jwt_secret), 'SERVICE_KEY': jwt('service_role', jwt_secret),
        'AUTH_JWT_SECRET': jwt_secret, 'POSTGREST_URL': 'http://127.0.0.1:3000',
        'STORAGE_PUBLIC_URL': 'http://127.0.0.1:8000', 'FILE_SIZE_LIMIT': '52428800',
        'TENANT_ID': 'stub', 'REGION': 'stub', 'GLOBAL_S3_BUCKET': 'stub',
        'DATABASE_URL': 'postgres://supabase_storage_admin:%s@127.0.0.1:5432/postgres' % storage_secret,
        'REQUEST_ALLOW_X_FORWARDED_PATH': 'true', 'STORAGE_BACKEND': 'file',
        'FILE_STORAGE_BACKEND_PATH': '/var/lib/storage', 'ENABLE_IMAGE_TRANSFORMATION': 'false'})
    result = docker('create', '--pull', 'never', '--network', 'container:' + container,
                    '--name', storage_name, '--label', 'org.sofia.sql-tests.owner=' + storage_name,
                    '--env-file', storage_env, storage_image)
    storage_cid = result.stdout.strip()
    if result.returncode or not re.fullmatch(r'[0-9a-f]{64}', storage_cid): raise ValueError('storage not created')
    created.append(storage_cid)
    if docker('start', storage_cid).returncode: raise ValueError('storage migrations failed')
    for attempt in range(45):
        ready = sql("select to_regclass('storage.buckets') is not null")
        if ready.returncode == 0 and ready.stdout.strip() == 't': break
        if attempt == 44: raise ValueError('storage migrations did not finish')
        time.sleep(2)
    docker('stop', storage_cid, timeout=120)
    status = 0
except Exception:
    pass  # Never echo Docker output, migration logs or generated secrets.
finally:
    if created:
        cleanup = 'removed'
        for cid in created:
            if docker('rm', '-f', '-v', cid).returncode:
                status, cleanup = 1, 'failed'
            inventory = docker('ps', '-aq', '--no-trunc', '--filter', 'id=' + cid)
            if inventory.returncode or inventory.stdout.strip():
                status, residue = 1, 'remaining'
            else:
                residue = 'absent-observed'
print('db_only_bootstrap: operation=%s status=%s cleanup=%s container_residue=%s'
      % (phase, 'ok' if status == 0 else 'failed', cleanup, residue))
sys.exit(status)
PY
}

# Hermetic preparation contract: the extensions the suites rely on and the template used
# for the per-suite reset, including the guarantee that a failure never leaves the
# database refusing connections.
db_only_prepare_self_check() {
  local fake="$work/run/prepare-docker" case_name status
  cat >"$fake" <<'PY'
#!/usr/bin/python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with Path(os.environ['DB_FAKE_LOG']).open('a') as stream:
    stream.write(json.dumps(args) + '\n')
case = os.environ['DB_FAKE_CASE']
assert args[:4] == ['exec', '-i', 'b' * 64, 'psql'], args
assert args[8:10] == ['-d', 'postgres'] and args[10:] == ['-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], args
body = sys.stdin.read()
if 'create extension if not exists pgtap' in body:
    assert 'create extension if not exists dblink with schema extensions;' in body
    assert 'create schema' not in body and 'create table' not in body
    sys.exit(1 if case == 'extensions-fail' else 0)
if 'allow_connections false' in body:
    assert body.count(';') == 1
    sys.exit(0)
if 'pg_terminate_backend' in body:
    compact = body.replace(' ', '')
    assert "datname='postgres'" in compact and 'pid<>pg_backend_pid()' in compact
    sys.exit(0)
if 'create database sofia_template template postgres' in body:
    sys.exit(1 if case == 'template-fail' else 0)
assert 'alter database sofia_template allow_connections true' in body
assert 'alter database postgres allow_connections true' in body
sys.exit(1 if case == 'restore-fail' else 0)
PY
  chmod +x "$fake"
  declare -F db_only_prepare >/dev/null || die 'DB-only preparation helper missing'
  for case_name in ok extensions-fail template-fail restore-fail; do
    export DB_FAKE_CASE="$case_name" DB_FAKE_LOG="$work/run/prepare-$case_name.jsonl"
    : >"$DB_FAKE_LOG"
    status=0
    db_only_prepare "$fake" "$(printf 'b%.0s' {1..64})" >"$work/run/prepare-output" 2>&1 || status=$?
    python3 - "$DB_FAKE_LOG" "$case_name" "$status" "$work/run/prepare-output" <<'PY'
import json, re, sys
from pathlib import Path
rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
case, status = sys.argv[2], int(sys.argv[3])
report = Path(sys.argv[4]).read_text()
match = re.fullmatch(r'db_only_prepare: operation=(extensions|template) status=(ok|failed) '
                     r'template=(created|absent)\n', report)
assert match, 'prepare report leaked output or omitted metadata'
assert (status == 0) == (case == 'ok'), (case, status, report)
assert match.groups() == ({'ok': ('template', 'ok', 'created'), 'extensions-fail': ('extensions', 'failed', 'absent'),
                          'template-fail': ('template', 'failed', 'absent'),
                          'restore-fail': ('template', 'failed', 'created')}[case]), (case, report)
bodies = [row for row in rows]
assert len(bodies) == ({'extensions-fail': 1, 'ok': 5, 'template-fail': 5, 'restore-fail': 5}[case]), (case, len(rows))
if case == 'extensions-fail':
    assert all(row[4:8] == ['-h', '127.0.0.1', '-U', 'supabase_admin'] for row in rows)
assert not any('PASSWORD' in arg.upper() or 'postgres://' in arg for row in rows for arg in row)
PY
  done
  unset DB_FAKE_CASE DB_FAKE_LOG
  log 'db_only_prepare_self_check=pass (fake-only: pgtap/dblink install, postgres->template copy with connections blocked, allow_connections always restored)'
}

# Prepare the isolated database for the suites: the test extensions plus a template
# database cloned from the bootstrapped one, so each suite can start from a known state.
# The clone needs an exclusive source, so the sessions held by the image's own background
# workers are blocked and terminated first, and both databases are left accepting
# connections again no matter how the copy ends.
db_only_prepare() {
  python3 - "$@" <<'PY'
import subprocess, sys
exe, container = sys.argv[1:3]
status, phase, template = 1, 'extensions', 'absent'

def docker(*args, timeout=120, stdin=None):
    return subprocess.run([exe, *args], input=stdin, capture_output=True, text=True, timeout=timeout)

def sql(statement, timeout=120):
    return docker('exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'supabase_admin',
                  '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-', stdin=statement, timeout=timeout)

try:
    result = sql('create extension if not exists pgtap with schema extensions;\n'
                 'create extension if not exists dblink with schema extensions;\n')
    if result.returncode:
        raise ValueError('test extensions not installed')
    phase = 'template'
    try:
        sql('alter database postgres allow_connections false;\n')
        sql('select count(*) from (select pg_terminate_backend(pid) from pg_stat_activity\n'
            "where datname = 'postgres' and pid <> pg_backend_pid()) terminated;\n")
        if sql('create database sofia_template template postgres;\n').returncode:
            raise ValueError('template database not created')
        template = 'created'
    finally:
        # Connections must come back even when the copy failed.
        if sql('alter database sofia_template allow_connections true;\n'
               'alter database postgres allow_connections true;\n').returncode:
            raise ValueError('connections were not restored')
    status = 0
except Exception:
    pass  # Never echo Docker output, SQL bodies or database output.
print('db_only_prepare: operation=%s status=%s template=%s'
      % (phase, 'ok' if status == 0 else 'failed', template))
sys.exit(status)
PY
}

# Hermetic bootstrap contract: a dedicated fake proves the argv, the 0600 env file and the
# failure/cleanup paths without ever touching a daemon.
db_only_bootstrap_self_check() {
  local fake="$work/run/bootstrap-docker" case_name status
  cat >"$fake" <<'PY'
#!/usr/bin/python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
log = Path(os.environ['DB_FAKE_LOG'])
with log.open('a') as stream:
    stream.write(json.dumps(args) + '\n')
case = os.environ['DB_FAKE_CASE']
auth_cid, storage_cid = 'e' * 64, 'f' * 64
storage_image = 'local-storage-image'
if args[0] == 'exec':
    body = sys.stdin.read()
    assert args == ['exec', '-i', 'b' * 64, 'psql', '-h', '127.0.0.1', '-U', 'supabase_admin',
                    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], args
    if 'alter user supabase_auth_admin with password' in body:
        assert 'alter user supabase_storage_admin with password' in body
        assert 'grant supabase_admin to postgres;' in body
        assert 'POSTGRES_PASSWORD' not in body
        sys.exit(1 if case == 'roles-fail' else 0)
    if "to_regclass('storage.buckets')" in body:
        print('t')
        sys.exit(0)
    assert 'create extension' not in body
    assert 'create schema' not in body and 'create table' not in body
    sys.exit(0)
elif args[0] == 'create':
    envfile = Path(args[args.index('--env-file') + 1])
    assert envfile.stat().st_mode & 0o777 == 0o600
    body = envfile.read_text()
    assert args[1:5] == ['--pull', 'never', '--network', 'container:' + 'b' * 64]
    assert '--tmpfs' not in args and '-p' not in args and '--publish' not in args
    if body.startswith('API_EXTERNAL_URL=http://127.0.0.1:9999\n'):
        assert 'postgres://supabase_auth_admin:' in body and 'GOTRUE_JWT_SECRET=' in body
        assert body.count('GOTRUE_DB_MIGRATIONS_PATH=/usr/local/etc/auth/migrations') == 1
        assert args[args.index('--entrypoint') + 1] == 'auth' and args[-1] == 'migrate'
        if case == 'create-fail': sys.exit(1)
        print(auth_cid)
    else:
        assert 'DATABASE_URL=postgres://supabase_storage_admin:' in body
        assert 'STORAGE_BACKEND=file' in body and 'FILE_STORAGE_BACKEND_PATH=/var/lib/storage' in body
        assert args[-2:] == [storage_image, 'node'] or args[-1].endswith('server.js') or storage_image in args
        secret = [row for row in body.splitlines() if row.startswith('AUTH_JWT_SECRET=')][0].split('=', 1)[1]
        keys = [row.split('=', 1)[1] for row in body.splitlines() if row[:7] in ('ANON_KE', 'SERVICE')]
        assert len(keys) == 2 and all(key.count('.') == 2 for key in keys) and keys[0] != keys[1]
        assert secret not in args and keys[0] not in args
        if case == 'storage-create-fail': sys.exit(1)
        print(storage_cid)
elif args[0] == 'start':
    assert args in (['start', auth_cid], ['start', storage_cid])
    if case == 'auth-fail' and args[1] == auth_cid: sys.exit(3)
    if case == 'storage-fail' and args[1] == storage_cid: sys.exit(4)
elif args[0] == 'stop':
    assert args == ['stop', storage_cid]
elif args[0] == 'rm':
    assert args[1:] == ['-f', '-v', auth_cid] or args[1:] == ['-f', '-v', storage_cid]
    sys.exit(1 if case == 'rm-fail' else 0)
else:
    assert args[:4] == ['ps', '-aq', '--no-trunc', '--filter']
    assert args[4] in ('id=' + auth_cid, 'id=' + storage_cid)
    print(args[4][3:] if case == 'residue' else '')
PY
  chmod +x "$fake"
  declare -F db_only_bootstrap >/dev/null || die 'DB-only bootstrap helper missing'
  for case_name in ok roles-fail create-fail auth-fail storage-create-fail storage-fail rm-fail residue; do
    export DB_FAKE_CASE="$case_name" DB_FAKE_LOG="$work/run/bootstrap-$case_name.jsonl"
    : >"$DB_FAKE_LOG"
    status=0
    db_only_bootstrap "$fake" "$(printf 'b%.0s' {1..64})" "$work/run" local-auth-image local-storage-image \
      >"$work/run/bootstrap-output" 2>&1 || status=$?
    python3 - "$DB_FAKE_LOG" "$case_name" "$status" "$work/run/bootstrap-output" <<'PY'
import json, re, sys
from pathlib import Path
rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
case, status = sys.argv[2], int(sys.argv[3])
ops = [row[0] for row in rows]
report = Path(sys.argv[4]).read_text()
match = re.fullmatch(
    r'db_only_bootstrap: operation=(roles|auth|storage|extensions) status=(ok|failed) '
    r'cleanup=(not-created|removed|failed) container_residue=(not-created|absent-observed|remaining)\n', report)
assert match, 'bootstrap report leaked output or omitted metadata'
assert (status == 0) == (case == 'ok'), (case, status, report)
expected_phase = {'roles-fail': 'roles', 'create-fail': 'auth', 'auth-fail': 'auth'}.get(case, 'storage')
assert match.group(1) == expected_phase, (case, report)
auth_created = case not in ('roles-fail', 'create-fail')
owned = int(auth_created) + int(auth_created and case not in ('auth-fail', 'storage-create-fail'))
assert ('create' in ops) == (case != 'roles-fail'), (case, ops)
assert ('start' in ops) == auth_created, (case, ops)
expected = {'roles-fail': ('not-created', 'not-created'), 'create-fail': ('not-created', 'not-created'),
            'rm-fail': ('failed', 'absent-observed'), 'residue': ('removed', 'remaining')}.get(
    case, ('removed', 'absent-observed'))
assert match.groups()[2:] == expected, (case, report)
assert all('postgres://' not in arg and 'PASSWORD' not in arg.upper() for row in rows for arg in row), 'bootstrap argv leaked a secret'
assert [row[0] for row in rows if row[0] in ('rm', 'ps')] == ['rm', 'ps'] * owned, (case, ops)
assert ('stop' in ops) == (case in ('ok', 'rm-fail', 'residue')), (case, ops)
PY
  done
  unset DB_FAKE_CASE DB_FAKE_LOG
  log 'db_only_bootstrap_self_check=pass (fake-only: reserved-role SQL, auth migrate exit, storage runner readiness, 0600 env argv, own-container cleanup and residue classification)'
}

# Hermetic DB-only lifecycle contract; these fixtures never contact a daemon.
db_only_self_check() {
  local fake="$work/run/db-only-docker" case_name status deadline
  local -a readiness_args
  cat >"$fake" <<'PY'
#!/usr/bin/python3
import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
log = Path(os.environ['DB_FAKE_LOG'])
history = [json.loads(line) for line in log.read_text().splitlines()]
with log.open('a') as stream:
    stream.write(json.dumps(args) + '\n')
case = os.environ['DB_FAKE_CASE']
image, cid = 'sha256:' + 'a' * 64, 'b' * 64
if args[:2] == ['image', 'inspect']:
    doc = {'Id': image, 'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}
    if case == 'volnull': doc['Config']['Volumes'] = None
    if case == 'volempty': doc['Config']['Volumes'] = {}
    if case == 'volbad': doc['Config']['Volumes']['/extra'] = {}
    if case == 'volmissing': del doc['Config']['Volumes']
    if case == 'voltype': doc['Config']['Volumes'] = []
    if case == 'volvalues': doc['Config']['Volumes']['/var/lib/postgresql/data'] = 'bad'
    if case == 'image': doc['Id'] = 'invalid'
    if '--format' in args: print('invalid' if case == 'image' else image)
    else: print('malformed' if case == 'voljson' else json.dumps([doc]))
elif args[0] == 'create':
    envfile = Path(args[args.index('--env-file') + 1])
    assert envfile.stat().st_mode & 0o777 == 0o600
    assert envfile.read_text().startswith('POSTGRES_PASSWORD=')
    print('' if case == 'partial' else cid)
    if case in ('create', 'partial'):
        print(envfile.read_text(), file=sys.stderr)
        sys.exit(1)
elif args[0] == 'inspect':
    create = next(row for row in history if row[0] == 'create')
    label = create[create.index('--label') + 1].split('=', 1)
    doc = {'Id': cid, 'Name': '/' + create[create.index('--name') + 1],
           'Image': image, 'Config': {'Labels': dict([label])},
           'HostConfig': {'NetworkMode': 'none', 'PortBindings': None,
                          'PublishAllPorts': False,
                          'Tmpfs': {'/var/lib/postgresql/data': ''}},
           'State': {'Status': 'created', 'Running': False},
           'Mounts': [{'Type': 'tmpfs', 'Source': '', 'Destination': '/var/lib/postgresql/data', 'RW': True}]}
    # Only the first inspect is the start gate; cleanup must recheck ownership.
    if not any(row[0] == 'inspect' for row in history):
        if case == 'empty': doc['HostConfig']['PortBindings'] = {}
        if case == 'ports': doc['HostConfig']['PortBindings'] = {'5432/tcp': [{'HostPort': '5432'}]}
        if case == 'network': doc['HostConfig']['NetworkMode'] = 'host'
        if case == 'publish': doc['HostConfig']['PublishAllPorts'] = True
        if case == 'id': doc['Id'] = 'c' * 64
        if case == 'pinned': doc['Image'] = 'sha256:' + 'c' * 64
        if case == 'name': doc['Name'] = '/foreign'
        if case == 'missing': del doc['HostConfig']['PortBindings']
        if case == 'running': doc['State'] = {'Status': 'created', 'Running': True}
        if case == 'state-missing': del doc['State']
        if case == 'state-type': doc['State'] = []
        if case == 'status-missing': del doc['State']['Status']
        if case == 'running-missing': del doc['State']['Running']
        if case == 'running-type': doc['State']['Running'] = 0
        if case == 'status': doc['State']['Status'] = 'exited'
        if case == 'bind': doc['Mounts'][0]['Type'] = 'bind'
        if case == 'volume': doc['Mounts'][0]['Type'] = 'volume'
        if case == 'mount-extra': doc['Mounts'].append(dict(doc['Mounts'][0]))
        if case == 'mount-missing': del doc['Mounts']
        if case == 'mount-type': doc['Mounts'] = {}
        if case == 'mount-path': doc['Mounts'][0]['Destination'] = '/extra'
        if case == 'mount-source': doc['Mounts'][0]['Source'] = '/host'
        if case == 'mount-rw': doc['Mounts'][0]['RW'] = False
        if case == 'tmpfs': doc['HostConfig']['Tmpfs'] = {}
    if case == 'owner' or (case == 'ready-owner' and any(row[0] == 'exec' for row in history)):
        doc['Config']['Labels'] = {'foreign': 'owner'}
    print('malformed' if case == 'malformed' else json.dumps([doc]))
elif args[0] == 'start' and case == 'start':
    print('POSTGRES_PASSWORD=synthetic-must-not-leak', file=sys.stderr)
    sys.exit(1)
elif args[0] == 'exec':
    assert args == ['exec', cid, 'psql', '-h', '127.0.0.1', '-p', '5432',
                    '-U', 'supabase_admin', '-d', 'postgres', '-Atc',
                    "select 1 from pg_roles where rolname = 'supabase_auth_admin'"]
    assert any(row == ['start', cid] for row in history)
    probes = sum(row[0] == 'exec' for row in history)
    if case == 'ready-hang': time.sleep(10)
    # 2 means TCP refused (the initdb server only listens on its socket).
    if case == 'ready-offline': sys.exit(2)
    if case == 'ready-retry' and probes < 2: sys.exit(2)
    if case == 'ready-refused' and probes < 1: sys.exit(2)
    # 0 with a non-sentinel body means the official init scripts are still running.
    if case == 'ready-sentinel' and probes < 2:
        print('0')
        sys.exit(0)
    if case == 'ready-reject': sys.exit(1)
    if case in ('ready-invalid', 'ready-unexpected'):
        print('POSTGRES_PASSWORD=synthetic-must-not-leak', file=sys.stderr)
        sys.exit(3 if case == 'ready-invalid' else 7)
    print('1')
elif args[0] == 'ps':
    assert args == ['ps', '-aq', '--no-trunc', '--filter', 'id=' + cid]
    if case in ('remove', 'residue'): print(cid)
    sys.exit(1 if case == 'inventory' else 0)
elif args[0] != 'start':
    assert args == ['rm', '-f', '-v', cid]
    sys.exit(1 if case == 'remove' else 0)
PY
  chmod +x "$fake"
  declare -F db_only_session >/dev/null || die 'DB-only lifecycle helper missing'
  local cases=(good empty running state-missing state-type status-missing running-missing running-type status
    volnull volempty volbad volmissing voltype volvalues voljson bind volume mount-extra mount-missing
    mount-type mount-path mount-source mount-rw tmpfs ports network publish owner malformed id pinned name missing create partial start remove image residue inventory
    ready-retry ready-sentinel ready-refused ready-reject ready-offline ready-invalid ready-unexpected ready-hang ready-owner)
  for case_name in "${cases[@]}"; do
    export DB_FAKE_CASE="$case_name" DB_FAKE_LOG="$work/run/db-only-$case_name.jsonl"
    : >"$DB_FAKE_LOG"
    status=0
    readiness_args=(1)
    if [[ "$case_name" == good ]]; then readiness_args=(); fi
    # Multi-probe cases need a cap that survives several fake process spawns.
    case "$case_name" in ready-retry | ready-sentinel | ready-refused) readiness_args=(5) ;; ready-hang) readiness_args=(20) ;; esac
    db_only_session "$fake" local-postgres "$work/run" - ${readiness_args[@]+"${readiness_args[@]}"} \
      >"$work/run/db-only-output" 2>&1 || status=$?
    [[ -s "$work/run/db-only-output" ]] || die 'DB-only helper omitted its bounded report'
    python3 - "$DB_FAKE_LOG" "$case_name" "$status" "$work/run/db-only-output" <<'PY'
import json, re, sys
from pathlib import Path
rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
case, status = sys.argv[2], int(sys.argv[3])
ops = [row[0] for row in rows]
accepted = ('good', 'empty', 'volnull', 'volempty', 'ready-retry', 'ready-sentinel', 'ready-refused')
readiness_failed = ('ready-reject', 'ready-offline', 'ready-invalid', 'ready-unexpected', 'ready-hang')
started = accepted + readiness_failed + ('start', 'remove', 'residue', 'inventory', 'ready-owner')
image_rejected = ('image', 'volbad', 'volmissing', 'voltype', 'volvalues', 'voljson')
assert (status == 0) == (case in accepted), (case, status)
assert ('start' in ops) == (case in started), (case, ops)
assert ('exec' in ops) == (case in started and case != 'start'), ('readiness probe missing', case, ops)
report = Path(sys.argv[4]).read_text()
match = re.fullmatch(
    r'db_only: operation=(image|create|inspect|start|readiness) status=(ok|failed) '
    r'cleanup=(not-created|unverified|removed|failed) container_residue=(not-created|unknown|remaining|absent-observed) '
    r'readiness=(not-checked|ready|deadline|probe-failed|probe-timeout)\n', report)
assert match, 'report leaked output or omitted metadata'
if case in image_rejected:
    expected_phase = 'image'
elif case in ('create', 'partial'):
    expected_phase = 'create'
elif case == 'start':
    expected_phase = 'start'
elif case in started:
    expected_phase = 'readiness'
else:
    expected_phase = 'inspect'
assert match.groups()[:2] == (expected_phase, 'ok' if status == 0 else 'failed')
expected_cleanup = {
    'owner': ('unverified', 'unknown'),
    'ready-owner': ('unverified', 'unknown'),
    'malformed': ('unverified', 'unknown'),
    'remove': ('failed', 'remaining'),
    'inventory': ('removed', 'unknown'),
    'residue': ('removed', 'remaining'),
}.get(case, ('not-created', 'not-created') if case in image_rejected else ('removed', 'absent-observed'))
assert match.groups()[2:4] == expected_cleanup, (case, report)
expected_ready = ('not-checked' if case not in started or case == 'start' else {
    'ready-offline': 'deadline', 'ready-hang': 'probe-timeout',
    'ready-reject': 'probe-failed', 'ready-invalid': 'probe-failed', 'ready-unexpected': 'probe-failed',
}.get(case, 'ready'))
assert match.group(5) == expected_ready, (case, report)
probes = [row for row in rows if row[0] == 'exec']
assert bool(probes) == (case in started and case != 'start'), (case, ops)
if probes:
    assert ops[3:5] == ['start', 'exec'], (case, ops)
    assert ops[4:4 + len(probes)] == ['exec'] * len(probes)
    assert all(row == ['exec', 'b' * 64, 'psql', '-h', '127.0.0.1', '-p', '5432',
                       '-U', 'supabase_admin', '-d', 'postgres', '-Atc',
                       "select 1 from pg_roles where rolname = 'supabase_auth_admin'"]
               for row in probes), (case, probes[0])
    expected_probes = {'ready-retry': 3, 'ready-sentinel': 3, 'ready-refused': 2}.get(case)
    if expected_probes: assert len(probes) == expected_probes, (case, len(probes))
    elif case == 'ready-offline': assert len(probes) >= 2, (case, len(probes))
    else: assert len(probes) == 1, (case, len(probes))
assert set(ops) <= {'image', 'create', 'inspect', 'start', 'exec', 'rm', 'ps'}
if case in image_rejected:
    assert ops == ['image']
else:
    create = rows[1]
    assert re.fullmatch(r'sofia-db-[0-9a-f]{32}', create[6])
    assert all(create[6] not in path.read_text() for path in Path(sys.argv[1]).parent.glob('db-only-*.jsonl') if str(path) != sys.argv[1])
    assert create[:7] == ['create', '--pull', 'never', '--network', 'none', '--name', create[6]]
    assert create[7:10] == ['--label', 'org.sofia.sql-tests.owner=' + create[6], '--env-file']
    assert create[11:] == ['--tmpfs', '/var/lib/postgresql/data', 'sha256:' + 'a' * 64]
    assert ops[:3] == ['image', 'create', 'inspect']
    assert ('rm' in ops) == (case not in ('owner', 'malformed', 'ready-owner'))
    if 'start' in ops: assert rows[3] == ['start', 'b' * 64]
    if 'rm' in ops: assert next(row for row in rows if row[0] == 'rm') == ['rm', '-f', '-v', 'b' * 64]
PY
  done
  # Invalid internal deadlines fail before any Docker command or resource creation.
  for deadline in 0 121 invalid ''; do
    export DB_FAKE_CASE=good DB_FAKE_LOG="$work/run/db-only-invalid-deadline.jsonl"
    : >"$DB_FAKE_LOG"
    status=0
    db_only_session "$fake" local-postgres "$work/run" - "$deadline" \
      >"$work/run/db-only-output" 2>&1 || status=$?
    [[ "$status" == 1 && ! -s "$DB_FAKE_LOG" ]] || die 'invalid readiness deadline accepted'
    [[ "$(<"$work/run/db-only-output")" == 'db_only: operation=image status=failed cleanup=not-created container_residue=not-created readiness=not-checked' ]] \
      || die 'invalid readiness deadline report mismatch'
  done
  # A caller-owned credentials file is used exactly as given: never regenerated, never
  # removed, and never world-readable.
  local credentials="$work/run/db-only-credentials" before after
  db_only_credentials "$credentials" || die 'credentials helper failed'
  [[ -f "$credentials" && "$(stat -c %a "$credentials")" == '600' ]] \
    || die 'credentials helper did not create a 0600 file'
  grep -qE '^POSTGRES_PASSWORD=[0-9a-f]{32,}$' "$credentials" \
    || die 'credentials helper wrote an unexpected secret shape'
  db_only_credentials "$work/run/db-only-credentials-second" || die 'credentials helper failed on reuse'
  cmp -s "$credentials" "$work/run/db-only-credentials-second" \
    && die 'credentials helper reused a secret between calls'
  before="$(sha256sum <"$credentials")"
  export DB_FAKE_CASE=good DB_FAKE_LOG="$work/run/db-only-credentials.jsonl"
  : >"$DB_FAKE_LOG"
  status=0
  db_only_session "$fake" local-postgres "$work/run" "$credentials" 1 \
    >"$work/run/db-only-output" 2>&1 || status=$?
  [[ "$status" == 0 ]] || die 'caller-owned credentials were not accepted'
  [[ -f "$credentials" ]] || die 'the session removed a caller-owned credentials file'
  after="$(sha256sum <"$credentials")"
  [[ "$before" == "$after" ]] || die 'the session rewrote a caller-owned credentials file'
  python3 - "$DB_FAKE_LOG" "$credentials" <<'PY'
import json, sys
from pathlib import Path
rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
create, = [row for row in rows if row[0] == 'create']
assert create[create.index('--env-file') + 1] == sys.argv[2], 'caller credentials were not the env file'
assert rows[3] == ['start', 'b' * 64]
assert [row[0] for row in rows][-1] == 'ps'
PY
  chmod 644 "$work/run/db-only-credentials-second"
  : >"$DB_FAKE_LOG"
  status=0
  db_only_session "$fake" local-postgres "$work/run" "$work/run/db-only-credentials-second" 1 \
    >"$work/run/db-only-output" 2>&1 || status=$?
  [[ "$status" == 1 && ! -s "$DB_FAKE_LOG" ]] || die 'a world-readable credentials file was accepted'
  [[ "$(<"$work/run/db-only-output")" == 'db_only: operation=image status=failed cleanup=not-created container_residue=not-created readiness=not-checked' ]] \
    || die 'rejected credentials report mismatch'
  unset DB_FAKE_CASE DB_FAKE_LOG
  log 'db_only_self_check=pass (fake-only: bootstrap-sentinel readiness/order/deadline, caller-owned-credentials, pinned-image/volumes, argv, stopped-state, tmpfs-only, pre-start-isolation, exact-owned-cleanup, bounded-reporting; not real residue proof)'
}

environment_self_check
db_only_self_check
db_only_bootstrap_self_check
db_only_prepare_self_check
tap_self_check
redact_self_check
normalization_self_check
inputs_self_check
diagnostics_self_check
failure_output_self_check

if [[ "$run_self_check_only" == true ]]; then
  log 'self_check: all non-Docker self-checks passed successfully'
  exit 0
fi

[[ "$(pwd -P)" == "$repo_root" ]] || die "run this harness from the repository root: $repo_root"
[[ "$(git rev-parse --show-toplevel 2>/dev/null)" == "$repo_root" ]] \
  || die 'repository root mismatch; refusing to run'
[[ -x "$cli" ]] || die "missing pinned Supabase CLI binary: $cli"
readonly cli
[[ -f "$repo_root/supabase/config.toml" ]] || die 'missing supabase/config.toml'
for suite in "${suites[@]}"; do
  [[ -f "$repo_root/$suite" ]] || die "missing suite file: $suite"
done

command -v realpath >/dev/null 2>&1 || die 'realpath is required to resolve suite includes'
timeout -k 5 "$docker_query_timeout_seconds" docker info >/dev/null 2>&1 \
  || die 'docker is unavailable; refusing to start a local stack'

# ---------------------------------------------------------------------------
# Private temporary project: config, migrations, and tests only, plus normalization.
# ---------------------------------------------------------------------------
read -r -a ports <<<"$(free_ports 8)"
api_port="${ports[0]}" db_port="${ports[1]}" shadow_port="${ports[2]}" pooler_port="${ports[3]}"
studio_port="${ports[4]}" smtp_port="${ports[5]}" analytics_port="${ports[6]}" inspector_port="${ports[7]}"
project_id="sofia-sql-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:8])')"

stage_temporary_inputs "$repo_root" "$work/project" "${suites[@]}"

normalize_temporary_tree "$work/project" "$project_id" "$expected_owner_transfers" \
  "api=$api_port" "db=$db_port" "shadow=$shadow_port" "pooler=$pooler_port" \
  "studio=$studio_port" "smtp=$smtp_port" "analytics=$analytics_port" "inspector=$inspector_port"

# ---------------------------------------------------------------------------
# Start, migrate, and seed the disposable stack.
# ---------------------------------------------------------------------------
log "starting disposable stack (project_id=$project_id, db_port=$db_port)"
if ! run_bounded 'supabase start' "$start_timeout_seconds" "$cli" start --workdir "$work/project" \
  --exclude studio,edge-runtime \
  >"$work/start.log" 2>&1; then
  log 'error: operation=supabase_start status=failed' >&2
  die 'disposable local Supabase failed to start'
fi
stack_started=true

if ! run_bounded 'initial supabase db reset' "$reset_timeout_seconds" \
  "$cli" db reset --local --workdir "$work/project" >"$work/reset.log" 2>&1; then
  log 'error: operation=initial_supabase_db_reset status=failed' >&2
  die 'product migration chain or seed failed during the initial local reset'
fi

if ! timeout -k 5 "$docker_query_timeout_seconds" "$cli" status --workdir "$work/project" -o env >"$work/status.env" 2>/dev/null; then
  log 'error: operation=supabase_status status=failed' >&2
  die 'could not read disposable stack status'
fi

status_value() {
  sed -n "s/^${1}=\"\{0,1\}\([^\"[:space:]]*\)\"\{0,1\}$/\1/p" "$work/status.env" | head -1
}
api_url="$(status_value API_URL)"
db_url="$(status_value DB_URL)"

if [[ "$api_url" != "http://127.0.0.1:$api_port" || "$db_url" != *"@127.0.0.1:$db_port/postgres"* ]]; then
  die 'safety gate rejected a non-disposable local target'
fi
grep -Fq "$protected_project_ref" "$work/status.env" \
  && die 'safety gate rejected a protected hosted project reference'

db_container="$(timeout -k 5 "$docker_query_timeout_seconds" docker ps \
  --filter "label=com.supabase.cli.project=$project_id" \
  --format '{{.Names}}' 2>/dev/null | grep -x "supabase_db_$project_id" || true)"
[[ -n "$db_container" ]] || die "could not find the disposable database container for $project_id"

owner_label="$(timeout -k 5 "$docker_query_timeout_seconds" docker inspect --format '{{index .Config.Labels "com.supabase.cli.project"}}' "$db_container" 2>/dev/null || true)"
[[ "$owner_label" == "$project_id" ]] || die 'database container ownership check failed'

db_image="$(timeout -k 5 "$docker_query_timeout_seconds" docker inspect --format '{{.Config.Image}}' "$db_container" 2>/dev/null || true)"
grep -q 'supabase/postgres:' <<<"$db_image" || die 'disposable database container is not a local Supabase postgres image'

# The connection string is built here, kept in this process, and passed only to psql
# (as its connection target and as the dblink variable). It never reaches stdout, and
# every failure excerpt is redacted before printing.
db_password="$(timeout -k 5 "$docker_query_timeout_seconds" docker exec "$db_container" printenv POSTGRES_PASSWORD 2>/dev/null || true)"
[[ -n "$db_password" ]] || die 'could not read the disposable database password'
conninfo="$(python3 -c 'import sys, urllib.parse; print("postgresql://postgres:%s@127.0.0.1:5432/postgres" % urllib.parse.quote(sys.argv[1], safe=""))' "$db_password")"
unset db_password

# ---------------------------------------------------------------------------
# Staged suite tree. psql runs inside the database container and resolves a relative
# `\ir` against the including file, so selected suites and their includes must exist there.
# `supabase db reset` may replace the database container, and a replaced container
# starts with an empty writable layer, so the tree is staged, verified, and staged again
# whenever a reset discarded it. The copy names the source directory contents (SRC/.)
# into a pre-created destination, because `docker cp DIR DEST` nests DIR under DEST once
# DEST exists and a second staging would then land one level too deep.
# ---------------------------------------------------------------------------
container_work="/tmp/sofia-sql-suites-$project_id"
readonly stage_timeout_seconds=120
readonly preflight_timeout_seconds=60

stage_supabase_tree() {
  run_bounded 'stage supabase tree' "$stage_timeout_seconds" docker exec "$db_container" \
    mkdir -p "$container_work/supabase" >/dev/null 2>&1 \
    || die "could not prepare $container_work inside $db_container"
  run_bounded 'stage supabase tree' "$stage_timeout_seconds" docker cp \
    "$work/project/supabase/." "$db_container:$container_work/supabase" >/dev/null 2>&1 \
    || die "could not copy the supabase tree into $db_container"
}

# Prints the in-container paths a suite needs: the suite file itself plus every relative
# `\ir` include it pulls in, because psql resolves those next to the including file.
suite_staged_paths() {
  local repo_suite=$1 name=$2 target resolved
  printf '%s\n' "$container_work/supabase/tests/$name"
  while read -r target; do
    [[ -n "$target" ]] || continue
    [[ "$target" != /* ]] || die "suite $name uses an absolute include: $target"
    resolved="$(realpath -m --relative-to="$repo_root" "$(dirname -- "$repo_suite")/$target")"
    [[ "$resolved" == supabase/* ]] || die "suite $name includes a path outside supabase/: $resolved"
    printf '%s\n' "$container_work/$resolved"
  done < <(sed -nE 's/^[[:space:]]*\\ir[[:space:]]+([^[:space:]]+).*$/\1/p' "$repo_suite")
}

# Bounded existence preflight before psql. A missing file makes psql abort on its first
# statement, and the suite would then report zero assertions instead of naming the real
# problem. One restaging attempt covers a container replaced by the previous reset;
# `restaged=` records whether that staging was actually needed.
# shellcheck disable=SC2016 # the in-container sh expands these, never the host bash
ensure_staged_suite() {
  local suite=$1 name=$2 attempt log_file
  log_file="$work/run/$name.staged.log"
  local -a paths=()
  mapfile -t paths < <(suite_staged_paths "$repo_root/$suite" "$name")
  for attempt in initial restaged; do
    if run_bounded "staged files $name" "$preflight_timeout_seconds" docker exec "$db_container" \
      sh -c '
        for path in "$@"; do
          [ -f "$path" ] || exit 1
        done
      ' staged-files "${paths[@]}" >/dev/null 2>&1; then
      log "preflight $name staged_files=${#paths[@]} restaged=$([[ "$attempt" == initial ]] && echo no || echo yes)"
      return 0
    fi
    [[ "$attempt" == initial ]] || break
    log "preflight $name staged_tree=incomplete action=restaging"
    stage_supabase_tree
  done
  log "error: operation=ensure_staged_suite suite=$name status=missing_files" >&2
  die 'staged suite files are missing inside container after restaging'
}

# One ephemeral loopback password rule for this disposable database only: the image lists
# `host all all 127.0.0.1/32 trust` before its scram rules, so an in-container loopback
# connection never exchanges a password and dblink_connect then refuses it for the
# non-superuser `postgres` role the suites run as. The prepended rule covers exactly
# postgres->postgres on loopback and leaves every other HBA line, role and service untouched;
# it lives only in this container and is re-applied idempotently after each reset.
readonly loopback_rule_marker='# sofia-sql-local-tests: loopback password authentication'
readonly loopback_rule="$loopback_rule_marker"$'\n'"host postgres postgres 127.0.0.1/32 scram-sha-256"

# shellcheck disable=SC2016 # the in-container sh expands these, never the host bash
ensure_loopback_password_rule() {
  local paths hba_file data_directory proof
  paths="$(timeout -k 5 "$docker_query_timeout_seconds" docker exec "$db_container" psql --no-psqlrc -X -tA -d "$conninfo" -c \
    "select current_setting('hba_file')||'|'||current_setting('data_directory')" 2>/dev/null || true)"
  IFS='|' read -r hba_file data_directory <<<"$paths"
  [[ -n "$hba_file" && -n "$data_directory" ]] || die 'could not read the disposable hba_file and data_directory'

  if timeout -k 5 "$docker_query_timeout_seconds" docker exec "$db_container" grep -qF "$loopback_rule_marker" "$hba_file" >/dev/null 2>&1; then
    log "loopback_password_rule=already-present hba=$hba_file"
  else
    run_bounded 'loopback password rule' "$preflight_timeout_seconds" docker exec -u postgres "$db_container" \
      sh -c '
        set -e
        hba="$1"
        tmp="$hba.sofia-sql-local-tests.new"
        printf "%s\n" "$2" >"$tmp"
        cat "$hba" >>"$tmp"
        mv "$tmp" "$hba"
        pg_ctl reload -D "$3"
      ' sofia-loopback-rule "$hba_file" "$loopback_rule" "$data_directory" >/dev/null 2>&1 \
      || die 'could not apply and reload the loopback password rule'
    log "loopback_password_rule=applied hba=$hba_file reload=ok"
  fi
  # Positive proof: this loopback path now exchanges a password as the non-superuser postgres role.
  proof="$(run_bounded 'loopback password probe' "$preflight_timeout_seconds" docker exec "$db_container" \
    psql --no-psqlrc -X -tA -F'|' -d "$conninfo" -c \
    "select current_user, (select rolsuper from pg_roles where rolname = current_user), 1" 2>/dev/null || true)"
  [[ "$proof" == 'postgres|f|1' ]] \
    || die 'the suite session must stay the non-superuser postgres role'
  # Negative proof: the same rule must reject a wrong password at the container-local 5432 port.
  run_bounded 'loopback wrong-password probe' "$preflight_timeout_seconds" docker exec \
    -e PGPASSWORD=sofia-sql-local-tests-wrong-password "$db_container" \
    psql --no-psqlrc -X -tA -h 127.0.0.1 -p 5432 -U postgres -d postgres -c 'select 1' \
    >/dev/null 2>&1 \
    && die 'the loopback password rule accepted a wrong password; refusing to run suites'
  log 'loopback_password_proof=password-accepted,wrong-password-rejected session=postgres|f|1'
}

# Staged and verified before the loop, so the per-suite preflight can tell "a reset
# discarded the staged tree" apart from "staging never reached the container".
stage_supabase_tree
ensure_staged_suite "${suites[0]}" "$(basename -- "${suites[0]}")"
ensure_loopback_password_rule

# Fail fast when the disposable connection string cannot reach its own database.
# Without this probe every suite would abort before its first assertion and the run
# would report zero-assertion results instead of a clear connection failure.
if ! run_bounded 'disposable db connectivity probe' 60 docker exec "$db_container" \
  psql --no-psqlrc --quiet --pset pager=off -d "$conninfo" -tAc 'select 1' \
  >/dev/null 2>&1; then
  log 'error: operation=db_connectivity_probe status=failed' >&2
  die 'the disposable database connection string did not connect; refusing to run suites'
fi

# ---------------------------------------------------------------------------
# Run each suite against its own freshly reset database.
# ---------------------------------------------------------------------------
total_tests=0
total_failed=0
failed_suites=()

for suite in "${suites[@]}"; do
  name="$(basename -- "$suite")"
  log "== suite: $name"

  if ! run_bounded "supabase db reset before $name" "$reset_timeout_seconds" \
    "$cli" db reset --local --workdir "$work/project" >"$work/run/$name.reset.log" 2>&1; then
    log "error: operation=suite_db_reset suite=$name status=failed" >&2
    die "product migration chain or seed failed before $name"
  fi

  # The reset above may have replaced the database container, whose fresh writable layer
  # holds neither the staged tree nor the ephemeral loopback password rule, so both are
  # re-verified idempotently immediately before psql.
  ensure_staged_suite "$suite" "$name"
  ensure_loopback_password_rule

  raw="$work/run/$name.raw"
  tap="$work/run/$name.tap"
  set +e
  # psql needs its own connection target: without -d it falls back to the container's
  # local socket as root, which fails peer authentication before any assertion runs.
  # -t -A keeps pgTAP's TAP lines free of psql headers and padding; ON_ERROR_STOP still aborts.
  run_bounded "psql $name" "$psql_timeout_seconds" docker exec "$db_container" \
    psql --no-psqlrc --quiet --tuples-only --no-align --pset pager=off -v ON_ERROR_STOP=1 \
    -d "$conninfo" \
    -v "runtime_dblink_conninfo=$conninfo" \
    -f "$container_work/supabase/tests/$name" >"$raw" 2>&1
  psql_status=$?
  set -e

  filter_tap "$raw" >"$tap"

  set +e
  tap_output="$(validate_tap "$tap" 2>"$work/run/$name.tap.err")"
  tap_status=$?
  set -e

  tests="$(sed -nE 's/^TAP_RESULT tests=([0-9]+) failed=([0-9]+) plan=([0-9]+) problems=([0-9]+)$/\1/p' <<<"$tap_output" | head -1)"
  failed="$(sed -nE 's/^TAP_RESULT tests=[0-9]+ failed=([0-9]+) .*$/\1/p' <<<"$tap_output" | head -1)"
  tests="${tests:-0}"
  failed="${failed:-0}"
  total_tests=$((total_tests + tests))
  total_failed=$((total_failed + failed))

  if [[ "$psql_status" -eq 0 && "$tap_status" -eq 0 ]]; then
    log "PASS $name (assertions=$tests failed=0 psql_exit=0)"
  else
    failed_suites+=("$name")
    log "FAIL $name (assertions=$tests failed=$failed psql_exit=$psql_status tap_exit=$tap_status)"
    if [[ "$psql_status" -ne 0 ]]; then
      log "error: operation=psql suite=$name status=failed exit=$psql_status" >&2
      log "note: psql exit $psql_status aborts this suite only; later suites still run"
    fi
    if [[ -s "$work/run/$name.tap.err" ]]; then
      log "tap diagnostics:"
      cat "$work/run/$name.tap.err"
    fi
  fi
done

log "summary: suites=${#suites[@]} assertions=$total_tests failed_assertions=$total_failed failing_suites=${#failed_suites[@]}"
if ((${#failed_suites[@]})); then
  printf 'failing suites: %s\n' "${failed_suites[*]}" >&2
  exit 1
fi
log 'all selected suites passed'
}

sanitized_exec /nonexistent /tmp /bin/bash --noprofile --norc -c \
  "$(declare -f sanitized_exec runner_main); runner_main \"\$@\"" \
  "${BASH_SOURCE[0]}" "$@"
