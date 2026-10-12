#!/bin/sh
set -eu

here="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
cd "$here"

docker compose config --quiet

expected_containers="
asados-supabase-envoy
asados-supabase-auth
asados-supabase-rest
realtime-dev.supabase-realtime
asados-supabase-storage
asados-supabase-edge-functions
asados-supabase-db
"

for container in $expected_containers; do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
  test "$status" = healthy || {
    echo "$container is not healthy: ${status:-missing}" >&2
    exit 1
  }
done

api_port="$(sed -n 's/^API_GW_HTTP_PORT=//p' .env)"
anon_key="$(sed -n 's/^ANON_KEY=//p' .env)"
curl --fail --silent --show-error \
  -H "apikey: $anon_key" \
  -H "Authorization: Bearer $anon_key" \
  "http://${api_port}/auth/v1/health" >/dev/null

echo "Self-hosted Supabase stack is healthy"
