# Integrated production services

The application uses the public domain for browser traffic and private Docker DNS for server-to-server calls. Supabase Studio, Evolution Manager, PostgreSQL, and Redis are not publicly routed.

## Quick verification

```bash
docker compose up -d
npm run integration:verify
```

The command succeeds only when the application, Supabase, Evolution API, both PostgreSQL databases, Redis, and the authenticated Evolution webhook are healthy.

## Traffic map

| Traffic | Route |
|---|---|
| Browser → application | `https://crmsofiamanager.duckdns.org` |
| Browser → Supabase data plane | Same-origin `/auth/v1`, `/rest/v1`, `/storage/v1`, `/realtime/v1`, and `/functions/v1` |
| Application → Supabase | `http://api-gw:8000` on `asados-supabase-private` |
| Application → Evolution API | `http://evolution-api:8080` on `asados-app-private` |
| Evolution API → webhook | `https://crmsofiamanager.duckdns.org/api/webhooks/evolution` with the dedicated secret |

## Security boundary

- Nginx exposes only the application and Supabase data-plane paths.
- Evolution API and the application publish maintenance ports on loopback only.
- PostgreSQL, Redis, Studio, Evolution Manager, and Supabase administrative services have no public route.
- Browser code receives only the anonymous Supabase key. The service-role key and internal URL remain server-only.
- Auth accepts the production callback and the explicit loopback maintenance callback; broad wildcard redirects are disabled.

## Environment contract

| Variable | Production value or purpose |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://crmsofiamanager.duckdns.org` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://crmsofiamanager.duckdns.org` |
| `SUPABASE_INTERNAL_URL` | `http://api-gw:8000` |
| `EVOLUTION_API_URL` | `http://evolution-api:8080` |
| `EVOLUTION_WEBHOOK_SECRET` | Dedicated server-side secret; never committed |

## Operational note

The ingress configuration lives in the Portafolio project (`portfolio-nginx`); this repository no longer carries an nginx config. Apply the ingress change there and issue the public TLS certificate during the deployment phase. Phase 5 validates the configuration syntax and local integrated runtime without opening administrative endpoints. The operational source of truth for that ingress is `docs/runbooks/domain-deployment.md`.

## Evolution webhook body limit

The Evolution webhook accepts payloads up to 10 MiB. The limit is `client_max_body_size 10M`, scoped to an exact `location = /api/webhooks/evolution` so the generic application upload limit is not widened. The live ingress enforces it, and that configuration lives in the separate `Portafolio` project (`portfolio-nginx`, sites under `nginx/sites/`), not in this repository. What governs production is the configuration rendered in the running container:

```bash
docker exec portfolio-nginx nginx -T
```

Changing this limit is an ingress change in that project. The deploy smoke asserts the behaviour: after promotion it runs `scripts/verify-webhook-ingress-limit.sh` against the public origin, which declares an 11 MiB `Content-Length` for `/api/webhooks/evolution` and sends no body, and requires HTTP 413 together with a zero-byte upload. Nothing is ever uploaded, in either outcome: the probe has no body to send, so the ingress is exercised through its own size check on the declared length and the check cannot mutate production. A non-413 answer, a nonzero upload, or a request that stalls until the timeout fails the smoke and the promotion is rolled back.

What that check does not cover: it asserts the 413 on an oversized declared length, not the exact 10 MiB boundary and not the `location =` scoping that keeps the limit off the generic application routes; because it drives that size check without sending a real payload, it does not exercise how the application handles an oversized body the ingress accepted. CI cannot assert the external ingress, since the live assertion only happens at deploy time against the public domain.
