#!/usr/bin/env bash
# Asserts that the live ingress rejects an oversized Evolution webhook request with 413.
#
# The probe never sends a body in either outcome: it declares an oversized
# `Content-Length` and writes zero bytes, so it exercises the ingress's size
# check on that length and cannot upload; a broken limit only stalls the request
# until `--max-time` aborts it. Success needs HTTP 413 and a zero-byte upload.
#
# Every argument and override is validated before the request: an unusable value
# exits 2 as an argument error, never as an ingress verdict.
set -Eeuo pipefail
set +x

webhook_path='/api/webhooks/evolution'
# An empty override is treated as unset (bash `:-` semantics) and keeps the default.
oversized_bytes="${ASADOS_WEBHOOK_INGRESS_LIMIT_BYTES:-11534336}"
timeout_seconds="${ASADOS_WEBHOOK_INGRESS_LIMIT_TIMEOUT_SECONDS:-60}"

usage() {
  printf 'Usage: %s <base-url> [expected-code]\n' "$0" >&2
  printf 'Declares an oversized Content-Length for %s and requires HTTP 413.\n' "$webhook_path" >&2
  printf 'base-url must be an absolute http:// or https:// URL.\n' >&2
  printf 'Override the declared size with ASADOS_WEBHOOK_INGRESS_LIMIT_BYTES (bytes).\n' >&2
  printf 'Override the request deadline with ASADOS_WEBHOOK_INGRESS_LIMIT_TIMEOUT_SECONDS.\n' >&2
}

base_url="${1:-}"
expected_code="${2:-413}"

[[ -n "$base_url" ]] || { usage; exit 2; }
[[ "$base_url" =~ ^https?://[^[:space:]]+$ ]] || {
  printf 'base-url must be an absolute http(s) URL with a host: %s\n' "$base_url" >&2
  exit 2
}
[[ "$expected_code" =~ ^[1-9][0-9]{2}$ ]] || {
  printf 'expected-code must be a three-digit HTTP status (for example 413): %s\n' "$expected_code" >&2
  exit 2
}
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

# A hard transport failure still prints `000 <bytes>`, so a bare `%{http_code}`
# is not enough: both fields must parse before either outcome is reported.
code=''
uploaded=''
read -r code uploaded <<<"$result" || true
if [[ ! "$code" =~ ^[0-9]{3}$ || ! "$uploaded" =~ ^[0-9]+$ ]]; then
  printf 'curl returned an unparseable result for POST %s: %q (expected "<http_code> <size_upload>").\n' \
    "$target" "$result" >&2
  exit 1
fi

if [[ "$uploaded" != '0' ]]; then
  printf 'Oversized webhook body reached the ingress: POST %s uploaded %s bytes, expected 0 (the probe must never send a body).\n' \
    "$target" "$uploaded" >&2
  exit 1
fi

if [[ "$code" != "$expected_code" ]]; then
  printf 'Oversized webhook request was not rejected: POST %s declaring %s bytes expected %s, observed %s.\n' \
    "$target" "$oversized_bytes" "$expected_code" "$code" >&2
  exit 1
fi

printf 'POST %s -> %s (oversized %s-byte Content-Length rejected with no body sent; uploaded %s bytes)\n' \
  "$target" "$code" "$oversized_bytes" "$uploaded"
