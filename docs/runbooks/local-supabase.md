# Local Supabase development

The local stack is a development dependency and is intentionally separate from the production self-hosting topology.

## Prerequisites

- Node.js 22
- Docker Engine with Compose
- Access to the Docker daemon

## Clean startup

```bash
npm ci
npm run supabase:start
npm run supabase:reset
npm run supabase:test
```

`supabase:reset` recreates only the local database on `127.0.0.1:54322`, applies every migration, and loads `supabase/seed.sql`. Do not use it for a hosted project.

Copy `.env.local.example` to `.env.local`, then obtain the local keys without committing them:

```bash
npm run supabase:status -- -o env
```

Keep `NEXT_PUBLIC_SUPABASE_URL` equal to `http://127.0.0.1:54321`. The E2E fixture rejects any other URL before it invokes Docker or mutates data.

## Verification

```bash
npm run supabase:test
npm run test:e2e
```

The SQL suite runs with pgTAP inside the local database. Playwright reads the local keys directly from `supabase status` and uses a single worker to avoid shared-database races.

## Stop

```bash
npm run supabase:stop
```

Use `npm run supabase:stop -- --no-backup` only when intentionally discarding local Docker state. The reset command is the reproducibility gate and should remain successful afterward.

## Test runners: Local CLI vs Self-hosted

- **Local CLI suite (`npm run supabase:test`):** Runs pgTAP tests inside the local CLI-managed database on `127.0.0.1:54322`. It is separate from the self-hosted topology.
- **Self-hosted test runner (`npm run selfhost:test:db` via `scripts/run-selfhost-supabase-tests.sh`):** Executes isolated SQL tests directly against the self-hosted Compose stack (`asados-supabase-db`).

When executing the self-hosted test runner from a linked Git worktree:
- Automatic canonical-checkout environment discovery finds the canonical checkout via Git common-dir (with a `worktree list --porcelain` fallback) when `ops/supabase/.env` is absent locally.
- The discovered environment is passed via `--env-file` directly to Docker Compose calls without touching the worktree.
- Creating temporary `.env` links or copies inside linked worktrees is strictly forbidden.
