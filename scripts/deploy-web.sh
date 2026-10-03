#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_root="${ASADOS_DEPLOY_STATE_ROOT:-/var/lib/asados/deploy}"
smoke="$root/scripts/smoke-production-readonly.sh"
ingress_limit_probe="$root/scripts/verify-webhook-ingress-limit.sh"
preflight="$root/scripts/workspace-preflight.sh"
public_origin="${ASADOS_PUBLIC_ORIGIN:-https://crmsofiamanager.duckdns.org}"
health_timeout="${ASADOS_WEB_HEALTH_TIMEOUT_SECONDS:-180}"
scheduler_health_timeout="${ASADOS_SOFIA_SCHEDULER_HEALTH_TIMEOUT_SECONDS:-180}"

usage() {
  printf '%s\n' \
    "Usage: $0 deploy <local-immutable-image-ref>" \
    "       $0 deploy --closed-gates <local-immutable-image-ref>" \
    "       $0 deploy --web-only <local-immutable-image-ref>" \
    "       $0 rollback" \
    "       $0 rollback --web-only"
}

action="${1:-}"
close_operational_gates=false
web_only=false
candidate_ref=""

case "$action" in
  deploy)
    case "${2:-}" in
      --closed-gates)
        [[ $# -eq 3 ]] || { usage >&2; exit 2; }
        close_operational_gates=true
        candidate_ref=$3
        ;;
      --web-only)
        [[ $# -eq 3 ]] || { usage >&2; exit 2; }
        web_only=true
        candidate_ref=$3
        ;;
      -*)
        usage >&2
        exit 2
        ;;
      *)
        [[ $# -eq 2 ]] || { usage >&2; exit 2; }
        candidate_ref=$2
        ;;
    esac
    ;;
  rollback)
    case "${2:-}" in
      "")
        [[ $# -eq 1 ]] || { usage >&2; exit 2; }
        ;;
      --web-only)
        [[ $# -eq 2 ]] || { usage >&2; exit 2; }
        web_only=true
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

# The running stack does not necessarily use the historical `asados` Compose project name.
# `docker compose` only recognises its own containers when the project name matches, so
# resolve it from the running Web container and let the operator override it explicitly.
resolve_compose_project() {
  local detected
  if [[ -n "${ASADOS_COMPOSE_PROJECT:-}" ]]; then
    printf '%s\n' "$ASADOS_COMPOSE_PROJECT"
    return 0
  fi
  if docker inspect crm-sofia-web >/dev/null 2>&1; then
    detected="$(docker inspect crm-sofia-web --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
  else
    detected="$(docker inspect asados-web --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
  fi
  if [[ -n "$detected" ]]; then
    printf '%s\n' "$detected"
    return 0
  fi
  printf '%s\n' 'asados'
}

compose_project="$(resolve_compose_project)"

require_immutable_local_image() {
  local ref=$1
  [[ "$ref" != *@* && "$ref" == *:* && "$ref" != *:latest ]] || {
    printf 'An explicit immutable local image tag is required: %s\n' "$ref" >&2
    exit 2
  }
  docker image inspect "$ref" >/dev/null
}

image_id() {
  docker image inspect "$1" --format '{{.Id}}'
}

wait_healthy() {
  local deadline=$((SECONDS + health_timeout))
  while (( SECONDS < deadline )); do
    local status=""
    if docker inspect crm-sofia-web >/dev/null 2>&1; then
      status="$(docker inspect crm-sofia-web --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    else
      status="$(docker inspect asados-web --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    fi
    [[ "$status" == healthy ]] && return 0
    sleep 2
  done
  printf 'Web did not become healthy within %s seconds\n' "$health_timeout" >&2
  return 1
}

wait_sofia_scheduler_healthy() {
  local deadline=$((SECONDS + scheduler_health_timeout))
  while (( SECONDS < deadline )); do
    [[ "$(docker inspect asados-sofia-inbound-batch-maintenance --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)" == healthy ]] && return 0
    sleep 2
  done
  printf 'Sofia scheduler did not become healthy within %s seconds\n' "$scheduler_health_timeout" >&2
  return 1
}

recreate_sofia_scheduler() {
  docker compose -f "$root/docker-compose.yml" --project-directory "$root" --project-name "$compose_project" \
    up -d --no-deps --force-recreate sofia-inbound-batch-maintenance
  wait_sofia_scheduler_healthy
}

stop_sofia_scheduler() {
  docker stop asados-sofia-inbound-batch-maintenance >/dev/null 2>&1 || true
}

OPERATIONAL_GATES=(
  PAYMENT_PROOF_CANONICAL_INGEST_ENABLED
  WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED
  TELEGRAM_PAYMENT_PROOF_INGEST_ENABLED
  PAYMENT_PROOF_PROCESSING_ENABLED
  PAYMENT_PROOF_SELLER_RECONCILIATION_ENABLED
  PAYMENT_PROOF_PRIVILEGED_REPLAY_ENABLED
  PAYMENT_PROOF_CLEANUP_ENABLED
  PAYMENT_PROOF_RESTORE_ENABLED
  NOTIFICATION_OUTBOX_DISPATCH_ENABLED
  WEB_NOTIFICATION_OUTBOX_DISPATCH_ENABLED
  WHATSAPP_NOTIFICATION_OUTBOX_DISPATCH_ENABLED
  TELEGRAM_NOTIFICATION_OUTBOX_DISPATCH_ENABLED
  SOFIA_INBOUND_BATCH_PROCESSING_ENABLED
  SOFIA_INBOUND_BATCH_RUNTIME_ENABLED
  SOFIA_INBOUND_BATCH_TELEGRAM_ENQUEUE_ENABLED
  SOFIA_INBOUND_BATCH_EVOLUTION_ENQUEUE_ENABLED
  SOFIA_CUSTOMER_MEMORY_ENABLED
)

declare -A CURRENT_GATES=()

inspect_current_gates() {
  local container=$1
  local raw_env
  raw_env="$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null)" || {
    printf 'Failed to inspect configuration of %s\n' "$container" >&2
    exit 1
  }
  for gate in "${OPERATIONAL_GATES[@]}"; do
    local parse_result
    parse_result="$(printf '%s\n' "$raw_env" | awk -F= -v g="$gate" '
      $1 == g { count++; val=substr($0, length(g) + 2) }
      END {
        if (count == 0) { exit 2 }
        if (count > 1) { exit 3 }
        print val
      }
    ')" || {
      local status=$?
      if [[ $status -eq 3 ]]; then
        printf 'Operational gate %s appears multiple times in %s\n' "$gate" "$container" >&2
      else
        printf 'Operational gate %s is absent or unavailable in %s\n' "$gate" "$container" >&2
      fi
      exit 1
    }
    if [[ "$parse_result" != "true" && "$parse_result" != "false" ]]; then
      printf 'Operational gate %s has malformed value in %s: %s\n' "$gate" "$container" "$parse_result" >&2
      exit 1
    fi
    CURRENT_GATES["$gate"]="$parse_result"
  done
}

recreate_and_verify_web_only() {
  local ref=$1 expected_id=$2
  local env_args=()
  for gate in "${OPERATIONAL_GATES[@]}"; do
    env_args+=("${gate}=${CURRENT_GATES[$gate]}")
  done
  env "${env_args[@]}" \
    CRM_SOFIA_WEB_IMAGE="$ref" \
    ASADOS_WEB_IMAGE="$ref" docker compose -f "$root/docker-compose.yml" \
      --project-directory "$root" --project-name "$compose_project" up -d --no-deps --force-recreate web || return 1
  wait_healthy || return 1
  ASADOS_EXPECTED_IMAGE_ID="$expected_id" "$smoke" || return 1
  "$ingress_limit_probe" "$public_origin" || return 1
}

recreate_and_verify() {
  local ref=$1 expected_id=$2 close_operational_gates=${3:-false}
  if [[ "$close_operational_gates" == true ]]; then
    PAYMENT_PROOF_CANONICAL_INGEST_ENABLED=false \
    WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED=false \
    TELEGRAM_PAYMENT_PROOF_INGEST_ENABLED=false \
    PAYMENT_PROOF_PROCESSING_ENABLED=false \
    PAYMENT_PROOF_SELLER_RECONCILIATION_ENABLED=false \
    PAYMENT_PROOF_PRIVILEGED_REPLAY_ENABLED=false \
    PAYMENT_PROOF_CLEANUP_ENABLED=false \
    PAYMENT_PROOF_RESTORE_ENABLED=false \
    SOFIA_INBOUND_BATCH_PROCESSING_ENABLED=false \
    SOFIA_INBOUND_BATCH_RUNTIME_ENABLED=false \
    SOFIA_INBOUND_BATCH_TELEGRAM_ENQUEUE_ENABLED=false \
    SOFIA_INBOUND_BATCH_EVOLUTION_ENQUEUE_ENABLED=false \
    SOFIA_CUSTOMER_MEMORY_ENABLED=false \
    CRM_SOFIA_WEB_IMAGE="$ref" \
    ASADOS_WEB_IMAGE="$ref" docker compose -f "$root/docker-compose.yml" \
      --project-directory "$root" --project-name "$compose_project" up -d --no-deps --force-recreate web || return 1
  else
    CRM_SOFIA_WEB_IMAGE="$ref" \
    ASADOS_WEB_IMAGE="$ref" docker compose -f "$root/docker-compose.yml" \
      --project-directory "$root" --project-name "$compose_project" up -d --no-deps --force-recreate web || return 1
  fi
  wait_healthy || return 1
  if [[ "$close_operational_gates" == true ]]; then
    stop_sofia_scheduler || return 1
  else
    recreate_sofia_scheduler || return 1
  fi
  ASADOS_EXPECTED_IMAGE_ID="$expected_id" "$smoke" || return 1
  "$ingress_limit_probe" "$public_origin" || return 1
}

write_state() {
  local previous_ref=$1 previous_id=$2 deployed_ref=$3 deployed_id=$4 mode=${5:-standard}
  local temporary="$state_root/release.env.tmp"
  {
    printf 'PREVIOUS_REF=%q\n' "$previous_ref"
    printf 'PREVIOUS_ID=%q\n' "$previous_id"
    printf 'DEPLOYED_REF=%q\n' "$deployed_ref"
    printf 'DEPLOYED_ID=%q\n' "$deployed_id"
    printf 'RECORDED_AT=%q\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'DEPLOY_MODE=%q\n' "$mode"
    if [[ "$mode" == "web-only" ]]; then
      for gate in "${OPERATIONAL_GATES[@]}"; do
        printf 'PRESERVED_GATE_%s=%q\n' "$gate" "${CURRENT_GATES[$gate]}"
      done
    fi
  } > "$temporary"
  mv -f -- "$temporary" "$state_root/release.env"
}

is_valid_image_ref() {
  local r=$1
  [[ "$r" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:-]*:[a-zA-Z0-9._-]+$ && "$r" != *@* && "$r" != *:latest ]]
}

is_valid_image_id() {
  local id=$1
  [[ "$id" =~ ^sha256:[0-9a-fA-F]{64}$ ]]
}

is_valid_utc_timestamp() {
  local ts=$1
  [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

load_state() {
  local state_file="$state_root/release.env"
  [[ -f "$state_file" ]] || {
    printf 'No rollback state exists at %s\n' "$state_file" >&2
    exit 1
  }

  PREVIOUS_REF=""
  PREVIOUS_ID=""
  DEPLOYED_REF=""
  DEPLOYED_ID=""
  RECORDED_AT=""
  DEPLOY_MODE=""
  CURRENT_GATES=()

  local line_num=0
  local line key val
  declare -A seen_keys=()

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_num=$((line_num + 1))
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      printf 'Invalid line format in release state at line %d\n' "$line_num" >&2
      exit 1
    fi

    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"

    if [[ -n "${seen_keys[$key]:-}" ]]; then
      printf 'Duplicate key %s in release state\n' "$key" >&2
      exit 1
    fi
    seen_keys["$key"]=1

    if [[ "$val" =~ ^\'(.*)\'$ ]] || [[ "$val" =~ ^\"(.*)\"$ ]]; then
      val="${BASH_REMATCH[1]}"
    fi

    case "$key" in
      PREVIOUS_REF)
        is_valid_image_ref "$val" || {
          printf 'Invalid image reference for PREVIOUS_REF in release state: %s\n' "$val" >&2
          exit 1
        }
        PREVIOUS_REF="$val"
        ;;
      PREVIOUS_ID)
        is_valid_image_id "$val" || {
          printf 'Invalid image ID for PREVIOUS_ID in release state: %s\n' "$val" >&2
          exit 1
        }
        PREVIOUS_ID="$val"
        ;;
      DEPLOYED_REF)
        is_valid_image_ref "$val" || {
          printf 'Invalid image reference for DEPLOYED_REF in release state: %s\n' "$val" >&2
          exit 1
        }
        DEPLOYED_REF="$val"
        ;;
      DEPLOYED_ID)
        is_valid_image_id "$val" || {
          printf 'Invalid image ID for DEPLOYED_ID in release state: %s\n' "$val" >&2
          exit 1
        }
        DEPLOYED_ID="$val"
        ;;
      RECORDED_AT)
        is_valid_utc_timestamp "$val" || {
          printf 'Invalid UTC timestamp for RECORDED_AT in release state: %s\n' "$val" >&2
          exit 1
        }
        RECORDED_AT="$val"
        ;;
      DEPLOY_MODE)
        if [[ "$val" != "web-only" && "$val" != "standard" ]]; then
          printf 'Unknown deploy mode in release state: %s\n' "$val" >&2
          exit 1
        fi
        DEPLOY_MODE="$val"
        ;;
      PRESERVED_GATE_*)
        local gate_name="${key#PRESERVED_GATE_}"
        local valid_gate=false
        for g in "${OPERATIONAL_GATES[@]}"; do
          if [[ "$g" == "$gate_name" ]]; then
            valid_gate=true
            break
          fi
        done
        if [[ "$valid_gate" != true ]]; then
          printf 'Unknown preserved gate in release state: %s\n' "$gate_name" >&2
          exit 1
        fi
        if [[ "$val" != "true" && "$val" != "false" ]]; then
          printf 'Invalid boolean value for %s in release state: %s\n' "$key" "$val" >&2
          exit 1
        fi
        CURRENT_GATES["$gate_name"]="$val"
        ;;
      *)
        printf 'Unknown key %s in release state\n' "$key" >&2
        exit 1
        ;;
    esac
  done < "$state_file"

  for required_key in PREVIOUS_REF PREVIOUS_ID DEPLOYED_REF DEPLOYED_ID RECORDED_AT; do
    if [[ -z "${seen_keys[$required_key]:-}" ]]; then
      printf 'Missing required state field %s in %s\n' "$required_key" "$state_file" >&2
      exit 1
    fi
  done

  local num_gates="${#CURRENT_GATES[@]}"
  if [[ -z "$DEPLOY_MODE" ]]; then
    if [[ $num_gates -gt 0 ]]; then
      printf 'Incompatible release state: preserved gates present without DEPLOY_MODE\n' >&2
      exit 1
    fi
  elif [[ "$DEPLOY_MODE" == "standard" ]]; then
    if [[ $num_gates -gt 0 ]]; then
      printf 'Incompatible release state: preserved gates present in standard deploy mode\n' >&2
      exit 1
    fi
  elif [[ "$DEPLOY_MODE" == "web-only" ]]; then
    if [[ $num_gates -ne ${#OPERATIONAL_GATES[@]} ]]; then
      printf 'Incompatible release state: web-only deploy mode requires all %d preserved gates (found %d)\n' "${#OPERATIONAL_GATES[@]}" "$num_gates" >&2
      exit 1
    fi
  fi
}

"$preflight" check "$state_root"
exec 9>"$state_root/deploy.lock"
flock -n 9 || { printf '%s\n' 'Another Web deployment is active' >&2; exit 1; }

case "$action" in
  deploy)
    require_immutable_local_image "$candidate_ref"
    candidate_id="$(image_id "$candidate_ref")"
    if docker inspect crm-sofia-web >/dev/null 2>&1; then
      current_container="crm-sofia-web"
    elif docker inspect asados-web >/dev/null 2>&1; then
      current_container="asados-web"
    else
      printf '%s\n' 'Running Web container not found' >&2
      exit 1
    fi
    current_id="$(docker inspect "$current_container" --format '{{.Image}}')"
    [[ -n "$current_id" ]] || {
      printf '%s\n' 'Could not resolve current Web container image ID' >&2
      exit 1
    }

    if [[ "$web_only" == true ]]; then
      inspect_current_gates "$current_container"
    fi

    rollback_ref="asados-web:rollback-${current_id#sha256:}"
    rollback_ref_modern="crm-sofia-web:rollback-${current_id#sha256:}"
    docker image tag "$current_id" "$rollback_ref"
    docker image tag "$current_id" "$rollback_ref_modern"
    previous_id="$(image_id "$rollback_ref")"

    if [[ "$web_only" == true ]]; then
      if ! recreate_and_verify_web_only "$candidate_ref" "$candidate_id"; then
        printf '%s\n' 'Promotion failed; restoring the retained previous image' >&2
        recreate_and_verify_web_only "$rollback_ref" "$previous_id"
        exit 1
      fi
      write_state "$rollback_ref" "$previous_id" "$candidate_ref" "$candidate_id" "web-only"
      printf 'Deployed %s (%s)\n' "$candidate_ref" "$candidate_id"
    else
      if ! recreate_and_verify "$candidate_ref" "$candidate_id" "$close_operational_gates"; then
        printf '%s\n' 'Promotion failed; restoring the retained previous image' >&2
        recreate_and_verify "$rollback_ref" "$previous_id" true
        exit 1
      fi
      write_state "$rollback_ref" "$previous_id" "$candidate_ref" "$candidate_id"
      printf 'Deployed %s (%s)\n' "$candidate_ref" "$candidate_id"
    fi
    ;;
  rollback)
    load_state
    require_immutable_local_image "$PREVIOUS_REF"
    [[ "$(image_id "$PREVIOUS_REF")" == "$PREVIOUS_ID" ]] || {
      printf '%s\n' 'Retained rollback tag no longer matches its recorded image ID' >&2
      exit 1
    }
    effective_mode="${DEPLOY_MODE:-standard}"
    if [[ "$web_only" == true ]]; then
      if [[ "$effective_mode" != "web-only" ]]; then
        printf '%s\n' 'Cannot perform web-only rollback: recorded state is not web-only' >&2
        exit 1
      fi
    elif [[ "$effective_mode" == "web-only" ]]; then
      web_only=true
    elif [[ "$effective_mode" != "standard" ]]; then
      printf 'Unknown deploy mode in release state: %s\n' "$effective_mode" >&2
      exit 1
    fi

    started=$SECONDS
    if [[ "$web_only" == true ]]; then
      for gate in "${OPERATIONAL_GATES[@]}"; do
        val="${CURRENT_GATES[$gate]:-}"
        if [[ "$val" != "true" && "$val" != "false" ]]; then
          printf 'Recorded operational gate %s is absent or malformed in release state\n' "$gate" >&2
          exit 1
        fi
      done
      recreate_and_verify_web_only "$PREVIOUS_REF" "$PREVIOUS_ID"
    else
      recreate_and_verify "$PREVIOUS_REF" "$PREVIOUS_ID" true
    fi
    elapsed=$((SECONDS - started))
    (( elapsed < 300 )) || {
      printf 'Rollback exceeded five minutes: %s seconds\n' "$elapsed" >&2
      exit 1
    }
    printf 'Rolled back to %s (%s) in %s seconds\n' "$PREVIOUS_REF" "$PREVIOUS_ID" "$elapsed"
    ;;
esac
