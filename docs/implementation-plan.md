# Migrate Asados to a self-hosted monorepo

This plan migrates the existing Next.js application without discarding the current uncommitted work. Each phase must satisfy its exit gate before the next phase begins.

## Execution board

| Phase | Deliverable | Exit gate | Status |
| --- | --- | --- | --- |
| 0 | Isolated branch and baseline inventory | Existing work is recoverable and the active branch is dedicated to the migration | Complete |
| 1 | Reproducible dependency baseline | Clean install completes; lint, unit tests, production build, and dependency audit pass | Complete |
| 2 | npm workspaces monorepo | Root commands build and test `apps/web`; one root lockfile remains | Complete |
| 3 | Local Supabase development stack | Migrations, seed, SQL tests, and guarded E2E run only against localhost | Complete |
| 4 | Persistent self-hosted Supabase stack | Services are healthy, data persists across restarts, backup and restore are proven | Complete |
| 5 | Application and service integration | Auth, Storage, Realtime, callbacks, CSP, and webhooks use the self-hosted endpoints | Complete |
| 6 | Production container verification | Images build; health checks, cold restart, tests, and persistence checks pass | Complete |
| 7 | Domain and TLS deployment | DNS resolves correctly and HTTPS serves a valid certificate for the requested hostname | Complete |
| 8 | Cutover and rollback | Smoke tests pass and the documented rollback is executable | Complete |

## Work units

### Phase 0 — Protect the baseline

- [x] Create `codex/asados-monorepo-selfhost` without cleaning the working tree.
- [x] Record tracked diffs, untracked paths, repository status, and tool versions.
- [x] Confirm no existing user change was overwritten.

### Phase 1 — Restore dependencies

- [x] Install exactly from `package-lock.json`.
- [x] Align and document the supported Node.js version.
- [x] Run lint, unit tests, and the production build.
- [x] Classify failures as pre-existing or migration-induced.

### Phase 1 evidence

- Environment: Node.js 22.23.1 on the host; the production image currently uses Node.js 24 Alpine. The monorepo phase must add an explicit repository version contract and converge these versions.
- Install: `npm ci --cache /tmp/asados-npm-cache` installed 565 packages. The first attempt exposed a non-writable global npm cache in the managed environment.
- Dependency security: npm reported seven high-severity advisories. They require a separate audit before applying upgrades; `npm audit fix --force` is not accepted as an automatic migration step.
- Lint: passed with eight pre-existing warnings and no errors.
- Unit tests in the unrestricted runtime: 415 passed and four timed out. Every remaining failure is in `tests/unit/slice2-hosted-receipt-harness.test.ts`; the shell harness sometimes exceeds Vitest's default five-second test timeout. No functional assertion failed.
- Production build: passed with `NODE_OPTIONS=--max-old-space-size=4096 npm run build`. The default two-gigabyte heap was insufficient during TypeScript checking. Network access is also required while the application uses remote Google fonts.
- Managed sandbox note: child-process fixtures fail with `EPERM` inside the restricted runtime; those are environment failures, not application regressions.

### Phase 1 remediation evidence

- ESLint: all eight warnings were removed; `npm run lint` exits cleanly with no warnings.
- Unit tests: the slow shell receipt cases now have narrowly scoped ten-second budgets based on measured runtimes above five seconds under load. The final unrestricted run passes all 61 files and all 419 tests.
- Profile effect: the Supabase client and navigation callback now have stable dependencies, preventing repeated data-loading effects while satisfying exhaustive dependency checks.
- Build isolation: remote Google font downloads were removed. The application uses a deterministic system font stack, so production builds no longer depend on Google Fonts availability.
- Build memory: the repository build command explicitly grants the Next.js compiler a four-gigabyte heap; the final production build passes without external environment flags.
- Runtime contract: Node.js is pinned to the 22 line in `.nvmrc`, `package.json`, and every Docker stage.
- Security: Next.js and `eslint-config-next` were upgraded to 16.3.0, safe transitive fixes were applied without `--force`, and `npm audit` reports zero vulnerabilities.

### Phase 2 — Create the monorepo

- [x] Add root npm workspaces and root orchestration scripts.
- [x] Move the Next.js application to `apps/web` with its runtime configuration.
- [x] Create shared packages only for proven architectural boundaries.
- [x] Update TypeScript, Vitest, Playwright, Docker, and documentation paths.
- [x] Re-run the complete Phase 1 gate from the repository root.

### Phase 2 evidence

- Workspace topology: the root `asados-monorepo` orchestrates `apps/*` and reserves `packages/*`; the deployable Next.js application is `@asados/web` in `apps/web`.
- Boundary discipline: repository-level tests, scripts, Supabase migrations, operations, and deployment orchestration remain at the root. No empty shared package was invented before a real reusable boundary exists.
- Next.js 16: the deprecated middleware convention was migrated to `apps/web/proxy.ts`; standalone tracing is rooted at the monorepo root.
- Clean install: `npm ci` installed 575 packages from the single root lockfile.
- Quality gate: ESLint exits cleanly; all 61 test files and 419 tests pass; the root production build completes without warnings.
- Security gate: `npm audit --audit-level=high` reports zero vulnerabilities.
- Container gate: Compose configuration validates and `docker build -t asados-web:phase2 .` completes successfully, including the workspace-aware install and standalone runtime at `apps/web/server.js`.

### Phase 3 — Run Supabase locally

- [x] Add a pinned Supabase CLI development dependency.
- [x] Start the local Docker stack and obtain local API keys.
- [x] Apply all migrations and seed data from a clean database.
- [x] Run SQL tests and guarded E2E tests against `127.0.0.1` only.
- [x] Add a safe local environment template without secrets.

### Phase 3 evidence

- Tooling: Supabase CLI is pinned exactly to 2.109.1 because 2.114.0 repeatedly raced its database restart health check on this host. Root scripts cover start, stop, status, reset, and pgTAP.
- Safety: `.env.local.example` contains localhost-only placeholders, and the E2E fixture rejects every non-local Supabase URL plus the former hosted project ID.
- Reproducibility: a clean `supabase db reset --local` applied all 37 migrations and `supabase/seed.sql`; the local API, Auth, Storage, Realtime, Studio, and database became healthy.
- Database gate: all five pgTAP files pass. The runtime inventory script now emits a valid TAP plan, while order-ledger inspection uses a transaction-local read policy without weakening production grants.
- Ordering integrity: product reordering now uses a service-role-only atomic database function; keyboard state is isolated from asynchronous React renders, removing the intermittent persisted-order race exposed by local E2E.
- Application gate: ESLint exits cleanly, all 61 unit-test files and 419 tests pass, the production build completes, and `npm audit` reports zero vulnerabilities.
- Browser gate: Chromium was installed for the pinned Playwright version; the six guarded browser scenarios execute against `http://127.0.0.1:54321` only.
- Operations: `docs/runbooks/local-supabase.md` documents prerequisites, safe startup, reset, testing, status inspection, and shutdown.

### Phase 4 — Self-host Supabase

- [x] Define production services, private networks, volumes, and health checks.
- [x] Externalize secrets and remove cloud project coupling.
- [x] Implement scheduled database and storage backups.
- [x] Prove restore into a clean stack.
- [x] Decide and execute cloud data migration when preservation is required.

### Phase 4 evidence

- Topology: the pinned official self-hosted Supabase distribution runs under `ops/supabase` with Kong, Auth, REST, Realtime, Storage, Meta, Studio, Functions, and Postgres. Every service has a health check and all internal services remain on `asados-supabase-private`.
- Minimal surface: only Kong and the database maintenance port bind to loopback. Imgproxy and Supavisor were removed because the application consumes neither transformations nor pooled SQL connections; this also removed unnecessary runtime warnings and resource use.
- Secrets: `generate-env.sh` creates unique credentials in an ignored mode-`0600` file. Compose validation succeeds without embedding secrets in tracked files.
- Schema: the persistent database contains all 37 application migrations and deterministic seed data. The five pgTAP contracts pass against the self-hosted database.
- Recovery: a checksummed logical backup of `public`, `auth`, `storage`, and migration history plus the Storage filesystem restored a deliberately deleted marker row. The restored state and migration count survived a complete Compose restart.
- Scheduling: a hardened systemd oneshot/timer executes daily checksummed backups with 14-day retention. A real scheduled invocation produced database, global-role, Storage, and checksum artifacts.
- Runtime gate: every container is healthy and a post-remediation log scan reports no warnings or errors. Known upstream defaults were removed or isolated without hiding unexpected process failures.
- Application gate: ESLint exits cleanly; all 61 files and 419 unit tests pass; the production build completes; `npm audit` reports zero vulnerabilities.
- Migration decision: no cloud import is required for this clean baseline. The paused hosted project remains untouched; an import will occur only if a later cutover explicitly requires preserving its data.

### Phase 5 — Integrate services

- [x] Configure public and server-side Supabase URLs and keys.
- [x] Configure Auth site URL, redirect allow-list, and callback behavior.
- [x] Update Nginx CSP and proxy routes.
- [x] Validate Evolution API and application webhooks.
- [x] Keep databases, Redis, Studio, and administrative endpoints private.

### Phase 5 evidence

- URL boundary: browser clients use the same-origin public domain while all server-side Supabase clients prefer `SUPABASE_INTERNAL_URL=http://api-gw:8000`; dedicated unit tests cover public, private, and local fallback resolution.
- Auth: `SITE_URL`, `API_EXTERNAL_URL`, and the redirect allow-list target the production domain, with only the exact production and loopback callback paths accepted.
- Proxy: Nginx exposes only the Supabase data-plane paths, carries Realtime WebSockets, removes the hosted-project CSP dependency, and does not route Studio or Evolution Manager. Its complete configuration passes `nginx -t` with isolated test certificates and unprivileged ports.
- Isolation: application and Evolution maintenance ports bind to loopback; databases and Redis have no published host ports. The web container joins the named Supabase network solely for private API access.
- Runtime: Web, Evolution API, Evolution PostgreSQL, Evolution Redis, and all nine Supabase containers report healthy. Private Web → Supabase and Web → Evolution requests both return HTTP 200.
- Webhook: Evolution's configured dedicated query secret is accepted, an invalid query credential remains rejected, and a live `connection.update` probe returns HTTP 200.
- Warning gate: startup notifier noise is disabled, the Evolution health check supplies the allowed Origin, and a combined application/Supabase log scan is clean for warnings and errors.
- Build hygiene: persistent Supabase data, repository intelligence, tests, docs, and operational state are excluded from the Docker build context, reducing it from roughly 520 MB to under 300 KB.

### Phase 6 — Verify production containers

- [x] Build all images from a clean cache.
- [x] Add readiness and liveness checks.
- [x] Validate persistence through a full Compose restart.
- [x] Run unit, integration, SQL, and E2E verification against the final topology.

### Phase 6 evidence

- Build: the Web image completed a pulled, no-cache production build; pull-only service images were refreshed separately.
- Health: `/api/health/live` is dependency-free, `/api/health/ready` checks authenticated Supabase Auth and Evolution, and every expected container must report healthy.
- Persistence: exact markers survived `docker compose down` followed by `up -d` in Supabase PostgreSQL, Supabase Storage, Evolution PostgreSQL, Evolution Redis, and the Evolution store volume. All markers were removed afterward.
- Verification: 426 unit tests, five pgTAP suites, six production E2E scenarios, and the final integration verifier passed.
- Browser topology: production E2E runs in the pinned official Playwright image against the ports published by the Compose topology; it does not start a development server or Supabase CLI stack.
- Hygiene: dependency audit, lint, diff whitespace checks, health gates, and the combined application/Supabase warning scan are clean.
- Operations: the complete repeatable procedure is documented in `docs/runbooks/production-container-verification.md`.

### Phase 7 — Deploy the domain

- [x] Verify DuckDNS points to the deployment host.
- [x] Issue a certificate containing `crmsofiamanager.duckdns.org`.
- [x] Configure automatic renewal and validate it without changing the live certificate.
- [x] Validate HTTP redirect, HTTPS, headers, WebSockets, and upstream isolation.

### Phase 7 evidence

- DNS: the public A record and the deployment host both resolve to `185.194.219.167`.
- Ingress: the domain is integrated into the existing `portfolio-nginx` owner of ports 80/443; it reaches Web and Supabase through their private Docker networks, without widening host bindings.
- TLS: Let's Encrypt issued an ECDSA certificate whose exact SAN is `crmsofiamanager.duckdns.org`, valid through 2026-11-11.
- Renewal: the existing daily Certbot job manages the shared certificate volume, and a scoped `renew --dry-run` completed successfully without replacing the live certificate.
- HTTP/HTTPS: HTTP redirects to HTTPS, an anonymous request to the root returns 307 to `/login`, and live/ready probes return 200.
- Security: HSTS, CSP, frame, MIME, referrer, and permissions headers are present. Realtime completed an HTTP 101 WebSocket upgrade.
- Isolation: only the Supabase data plane is routed; administrative paths return 404, while Web, Envoy, Evolution, and database host ports remain loopback-only and are unreachable through the public address.
- Upstream lifecycle: the re-audit reproduced a 502 after recreating `asados-web` because Nginx retained the container's previous IP. The shared ingress now uses Docker's embedded DNS resolver (`127.0.0.11`) and variable-based `proxy_pass` targets for both `asados-web` and `api-gw`, so their addresses are refreshed without restarting the ingress.
- Recreation gate: `asados-web` was recreated while `portfolio-nginx` remained running with the same start timestamp; the domain, liveness endpoint, and readiness endpoint recovered successfully through the unchanged ingress.

### Phase 8 — Cut over safely

- [x] Take final snapshots and schedule the cutover window.
- [x] Deploy and execute business-flow smoke tests.
- [x] Validate logs, health checks, and backup jobs.
- [x] Execute or dry-run the rollback procedure.

### Phase 8 evidence

- Recovery points: final Supabase and Evolution snapshots were created and their checksum manifests passed validation.
- Backup scheduling: the daily Supabase systemd timer is installed and enabled; a real service invocation completed successfully and produced a verified backup artifact.
- Promotion gates: the immutable Web image passed direct-origin and public HTTPS read-only smoke tests, health and isolation checks, and the integration verifier.
- Rollback: the guarded Web-only deployment retained the previous immutable image and restored it successfully in 9 seconds.
- Restore rehearsal: both archives validated in disposable stacks; the restored databases contained 24 Supabase `public` tables and 37 Evolution `public` tables.
- Probe classification: the malformed external `Next-Action: s4` request failed closed with HTTP 404 and `x-nextjs-action-not-found`; it was classified as an understood internet probe rather than an application failure.
- Log gate: the ingress review was scoped to `crmsofiamanager.duckdns.org`, and the Asados ingress logs were clean after the exact probe classification.

## Delivery rules

- Preserve user work; never clean or reset the working tree to make a phase pass.
- Keep tests and operational documentation with the behavior they verify.
- Do not expose service-role keys, database credentials, or internal data services.
- Do not treat `supabase start` as the production deployment topology.
- Stop at a failed phase gate, record evidence, and fix the smallest root cause before continuing.
