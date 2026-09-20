#!/usr/bin/env bash
set -Eeuo pipefail
set +x

public_origin="${ASADOS_PUBLIC_ORIGIN:-https://crmsofiamanager.duckdns.org}"
direct_origin="${ASADOS_DIRECT_ORIGIN:-http://127.0.0.1:3020}"
expected_image="${ASADOS_EXPECTED_IMAGE_ID:-}"

request() {
  local method=$1 url=$2 expected=$3
  local status
  status="$(curl --silent --show-error --output /dev/null \
    --request "$method" --write-out '%{http_code}' "$url")"
  [[ "$status" =~ ^($expected)$ ]] || {
    printf 'Unexpected %s status for %s: %s\n' "$method" "$url" "$status" >&2
    exit 1
  }
  printf '%s %s -> %s\n' "$method" "$url" "$status"
}

request GET "$direct_origin/api/health/live" 200
request GET "$direct_origin/api/health/ready" 200
request GET "$direct_origin/login" 200
request GET "$public_origin/" '307|308'
request GET "$public_origin/login" 200
request GET "$public_origin/api/health/live" 200
request GET "$public_origin/api/health/ready" 200
request GET "$public_origin/studio" 404
request GET "$public_origin/pg" 404

web_image="$(docker inspect asados-web --format '{{.Image}}')"
if [[ -n "$expected_image" && "$web_image" != "$expected_image" ]]; then
  printf 'Web image mismatch: expected %s, got %s\n' "$expected_image" "$web_image" >&2
  exit 1
fi

printf 'timestamp=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'web_image=%s\n' "$web_image"
printf '%s\n' 'Read-only production smoke passed'
