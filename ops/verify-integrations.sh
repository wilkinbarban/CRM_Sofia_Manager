#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

docker compose config --quiet
(cd ops/supabase && docker compose config --quiet)

assert_healthy() {
  container=$1
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
  [ "$status" = healthy ] || {
    echo "$container is not healthy: $status" >&2
    exit 1
  }
}

web_container=$(docker inspect crm-sofia-web >/dev/null 2>&1 && echo "crm-sofia-web" || echo "asados-web")
for container in "$web_container" asados-evolution-api asados-evolution-db asados-evolution-redis; do
  assert_healthy "$container"
done

./ops/supabase/verify.sh

docker exec "$web_container" node -e '
  Promise.all([
    fetch("http://api-gw:8000/auth/v1/settings", { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY } }),
    fetch("http://evolution-api:8080/", { headers: { Origin: "https://crmsofiamanager.duckdns.org" } }),
  ]).then((responses) => {
    if (responses.some((response) => !response.ok)) process.exit(1)
  }).catch(() => process.exit(1))
'

webhook_secret=$(sed -n 's/^EVOLUTION_WEBHOOK_SECRET=//p' .env)
[ -n "$webhook_secret" ]
curl -fsS -o /dev/null \
  -H 'content-type: application/json' \
  -H "x-webhook-secret: $webhook_secret" \
  --data '{"event":"connection.update"}' \
  'http://127.0.0.1:3020/api/webhooks/evolution'

echo 'Application, Supabase, Evolution API, PostgreSQL, Redis, and webhook integration are healthy'
