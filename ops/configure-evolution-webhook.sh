#!/usr/bin/env sh
set -eu

api_url="${EVOLUTION_API_URL:-http://evolution-api:8080}"
instance="${EVOLUTION_INSTANCE_NAME:?EVOLUTION_INSTANCE_NAME is required}"
api_key="${EVOLUTION_API_KEY:?EVOLUTION_API_KEY is required}"
webhook_secret="${EVOLUTION_WEBHOOK_SECRET:?EVOLUTION_WEBHOOK_SECRET is required}"
webhook_url="${EVOLUTION_WEBHOOK_URL:-http://web:3000/api/webhooks/evolution}"
app_origin="${NEXT_PUBLIC_APP_URL:-https://crmsofiamanager.duckdns.org}"

payload="$(
  node -e '
    process.stdout.write(JSON.stringify({
      webhook: {
        enabled: true,
        url: process.env.EVOLUTION_WEBHOOK_URL || "http://web:3000/api/webhooks/evolution",
        headers: { "x-webhook-secret": process.env.EVOLUTION_WEBHOOK_SECRET },
        byEvents: false,
        base64: false,
        events: ["MESSAGES_UPSERT"],
      },
    }))
  '
)"

curl --fail --silent --show-error \
  --request POST \
  --header "apikey: ${api_key}" \
  --header "Origin: ${app_origin}" \
  --header "Content-Type: application/json" \
  --data "${payload}" \
  "${api_url%/}/webhook/set/${instance}" >/dev/null

echo "Authenticated Evolution instance webhook configured."
