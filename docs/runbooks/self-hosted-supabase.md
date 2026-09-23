# Self-hosted Supabase operations

This production topology is based on the pinned official Supabase Docker Compose distribution with its official Kong gateway override. It is separate from the CLI-managed local development stack.

## Security boundary

- Only Kong (`127.0.0.1:8000` and `127.0.0.1:8443`) and the PostgreSQL maintenance endpoint bind to the host, always on loopback.
- Studio, Auth, REST, Realtime, Storage, Meta, and Functions remain on `asados-supabase-private`.
- `ops/supabase/.env` is generated locally in the canonical checkout with mode `0600` and is ignored by Git. Never copy, move, or symlink `.env` into linked Git worktrees; temporary environment links or copies are strictly forbidden.
- The public domain and TLS proxy are intentionally integrated in Phase 5 and deployed in Phase 7.
- Optional imgproxy and Supavisor services are omitted: the application does not consume image transformations or direct pooled database connections, so running them would add attack surface and idle warnings without a current requirement.

## First start

```bash
cd ops/supabase
./generate-env.sh
docker compose pull
docker compose up -d
./migrate.sh
./verify.sh
```

Wait until every service reports `healthy` before running `migrate.sh`; Storage and Realtime finish their managed schema initialization asynchronously.

## Backup

```bash
ops/supabase/backup.sh /var/backups/asados/supabase/manual-$(date -u +%Y%m%dT%H%M%SZ)
```

Each mode-`0700` backup contains a custom PostgreSQL dump for the `public`, `auth`, `storage`, and `supabase_migrations` schemas, global roles for disaster recovery, the Storage filesystem, and SHA-256 checksums.

Install `ops/systemd/asados-supabase-backup.service` and `.timer` with the repository deployed at `/usr/local/lib/asados/repo`. The timer runs daily, survives missed schedules, and retains 14 days by default.

## Restore

Restore is deliberately gated and stops database clients before replacing logical data and Storage files:

```bash
ops/supabase/restore.sh --confirm /var/backups/asados/supabase/<timestamp>
ops/supabase/verify.sh
```

The restore command validates every checksum before changing state. A Phase 4 proof restored a deleted marker row and then survived a complete Compose restart.

## Hosted-project migration decision

The self-hosted baseline is created from the repository's 37 migrations and deterministic seed. No hosted-project import is part of this phase: preservation of the paused cloud project was not requested, and importing unknown cloud state would violate the clean-baseline gate. If a later cutover explicitly requires that data, follow Supabase's platform-to-self-hosted restore procedure into a disposable validation stack before replacing this baseline.

## SQL test runners and linked worktrees

The repository provides two distinct test runners for database verification:
- **Local CLI runner (`npm run supabase:test`):** Uses the local Supabase CLI development stack and local CLI container on `127.0.0.1:54322`.
- **Self-hosted runner (`scripts/run-selfhost-supabase-tests.sh` or `npm run selfhost:test:db`):** Targets the self-hosted Docker Compose stack (`asados-supabase-db`) using disposable test databases and pgTAP harnesses.

When running self-hosted SQL tests from a linked Git worktree:
- The runner automatically discovers the canonical checkout's environment via Git common-dir (with a `worktree list --porcelain` fallback) when a local `ops/supabase/.env` is absent.
- The runner passes `--env-file <discovered-path>` directly to each Docker Compose invocation without mutating the worktree.
- Never use, copy, or symlink `.env` files into linked worktrees. If the environment file is missing, generate it in the canonical checkout with `ops/supabase/generate-env.sh`.
