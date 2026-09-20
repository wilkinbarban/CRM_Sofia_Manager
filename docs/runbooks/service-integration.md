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

Apply `nginx.conf` and issue the public TLS certificate during the deployment phase. Phase 5 validates the configuration syntax and local integrated runtime without opening administrative endpoints.
