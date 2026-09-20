#!/usr/bin/env bash
# Asserts that the live ingress rejects an oversized Evolution webhook request with 413.
#
# The probe never sends a body in either outcome: it declares an oversized
# `Content-Length` and writes zero bytes, so it exercises the ingress's size
# check on that length and cannot upload; a broken limit only stalls the request
# until `--max-time` aborts it. Success needs HTTP 413 and a zero-byte upload.
set -Eeuo pipefail
set +x

webhook_path='/api/webhooks/evolution'
oversized_bytes="${ASADOS_WEBHOOK_INGRESS_LIMIT_BYTES:-11534336}"
timeout_seconds="${ASADOS_WEBHOOK_INGRESS_LIMIT_TIMEOUT_SECONDS:-60}"

usage() {
  printf 'Usage: %s <base-url> [expected-code]\n' "$0" >&2
  printf 'Declares an oversized Content-Length for %s and requires HTTP 413.\n' "$webhook_path" >&2
  printf 'Override the declared size with ASADOS_WEBHOOK_INGRESS_LIMIT_BYTES (bytes).\n' >&2
}

base_url="${1:-}"
expected_code="${2:-413}"

[[ -n "$base_url" ]] || { usage; exit 2; }
[[ "$oversized_bytes" =~ ^[1-9][0-9]*$ ]] || {
  printf 'ASADOS_WEBHOOK_INGRESS_LIMIT_BYTES must be a positive integer: %s\n' "$oversized_bytes" >&2
  exit 2
}
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || {
  printf 'ASADOS_WEBHOOK_INGRESS_LIMIT_TIMEOUT_SECONDS must be a positive integer: %s\n' "$timeout_seconds" >&2
  exit 2
}

target="${base_url%/}$webhook_path"

# curl exits non-zero on an aborted transfer, so the observed code decides;
# stdin is /dev/null on purpose, so the declared length is never backed by bytes.
result="$(curl --silent --show-error --output /dev/null \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Content-Length: $oversized_bytes" \
  --data-binary @- \
  --max-time "$timeout_seconds" \
  --write-out '%{http_code} %{size_upload}' \
  "$target" </dev/null || true)"

code="${result%% *}"
uploaded="${result#* }"

if [[ -n "$uploaded" && "$uploaded" != '0' ]]; then
  printf 'Oversized webhook body reached the ingress: POST %s uploaded %s bytes, expected 0 (the probe must never send a body).\n' \
    "$target" "${uploaded:-unknown}" >&2
  exit 1
fi

if [[ "$code" != "$expected_code" ]]; then
  printf 'Oversized webhook request was not rejected: POST %s declaring %s bytes expected %s, observed %s.\n' \
    "$target" "$oversized_bytes" "$expected_code" "${code:-none}" >&2
  exit 1
fi

printf 'POST %s -> %s (oversized %s-byte Content-Length rejected with no body sent; uploaded %s bytes)\n' \
  "$target" "$code" "$oversized_bytes" "$uploaded"
