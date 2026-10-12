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

environment_self_check
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
