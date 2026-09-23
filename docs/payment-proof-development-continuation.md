# Payment-proof development continuation

> **Current answer (2026-09-07):** remain in `/home/wilkin/proyectos/Asados-worktrees/client-payment-fix-deploy` on `fix/client-payment-flow-deploy`. The five missing-original processing dead letters were dispositioned through an audited forward migration and current processing/outbox dead letters are 0/0. All 8 operational gates remain closed (`false`) pending a separate explicit reopening decision. Telegram evidence remains preserved.

## Quick resume path

1. Confirm this exact worktree, its Git root, and branch before any work.
2. Preserve the expected untracked OpenSpec change directory; it is authorized rollout work, not unrelated dirt.
3. Keep the current immutable image and current gates unchanged while completing the next implementation/documentation phases.
4. Before any production action, obtain its separate explicit authorization, verify redacted health/gate diagnostics, and use declarative gate change plus approved Web recreation only.
5. After implementation and pre-deployment verification are green, deploy one immutable final candidate to production for the owner-authorized bounded test, with pre/post health checks and immediate rollback on a stop condition.
6. Push and PR creation are authorized only after the final evidence phase; merge requires a separate final explicit permission.

## Current production baseline

| Item | Verified state |
| --- | --- |
| Immutable Web image | `asados-web:abc-audit-fix-579a4d8ffa58-20260907T025314Z` |
| Image digest | `sha256:e45dbadbc91e…` (sanitized prefix) |
| Deployment scope | A/B/C audit repair: supervisor/admin-only direct financial actions, durable reconciliation idempotency, and strict-stop posture. |
| Canonical intake | `PAYMENT_PROOF_CANONICAL_INGEST_ENABLED=false` |
| Processing | `PAYMENT_PROOF_PROCESSING_ENABLED=false` |
| Seller reconciliation | `PAYMENT_PROOF_SELLER_RECONCILIATION_ENABLED=false` |
| Cleanup | `PAYMENT_PROOF_CLEANUP_ENABLED=false` |
| Privileged replay | `PAYMENT_PROOF_PRIVILEGED_REPLAY_ENABLED=false` |
| WhatsApp intake | `WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED=false` |
| Telegram intake | `TELEGRAM_PAYMENT_PROOF_INGEST_ENABLED=false` |
| Restore | `PAYMENT_PROOF_RESTORE_ENABLED=false` |
| Current condition | Web and scheduler healthy with zero restarts; smoke passed; processing/outbox dead letters 0/0 after authorized quarantine + abandonment; gates remain closed pending explicit reopening. |

The seven gate values are evidence, not permission to mutate production. Gates are startup-captured declarative configuration: missing, malformed, unreadable, cache-local, database, runtime-override, and live-process changes fail closed or remain ineffective.

## Current local validation evidence

This evidence is local only. It does **not** claim that a production migration was applied, a production image was built or deployed, or a production canary ran.

| Check | Result |
| --- | --- |
| Self-host configuration | `npm run selfhost:config` passed. |
| Focused Telegram and restore gate validation | Passed. |
| Global Vitest | Prior baseline: 207 files passed and 1 skipped; 1,281 tests passed and 1 skipped. |
| Focused Vitest | 2026-09-07 authority/idempotency regression passed. |
| Isolated SQL harnesses | 2026-09-07: restore 28/28, replay 45/45, concurrency 4/4, reconciliation 20/20, admin workflow 2/2, lifecycle 1/1. |
| PostgREST integration | Real PostgREST v14.12 dispatcher idempotency integration passed. |
| TypeScript | `npx tsc --noEmit` passed. |
| Lint | Passed with 0 errors and 0 warnings. |
| Diff hygiene | `git diff --check` passed. |
| Production build | Passed with Next.js 16.3.0. |
| Dependency tree | npm-only local tree with React 19.2.4 and ReactDOM 19.2.4; no pnpm artifacts were used. |
| Database test runners | Distinction maintained: `npm run supabase:test` targets the local CLI database (`127.0.0.1:54322`), whereas `npm run selfhost:test:db` (`scripts/run-selfhost-supabase-tests.sh`) targets the self-hosted Compose stack (`asados-supabase-db`) with automatic canonical-checkout `.env` discovery for linked worktrees and zero `.env` copying or symlinking. |

## Sanitized completed canary evidence

| Canary | Completed evidence | Persistent boundary |
| --- | --- | --- |
| Web | Controlled canonical admission, asynchronous processing, privileged reconciliation, delivered-order transition, authenticated PDF receipt, and directed cleanup completed; the private-original/PNG-preview path and bounded queue/health observations were verified. | Record aggregate outcomes only; no content, storage reference, or full identifier. |
| Telegram | Controlled duplicate and unique admission branches, asynchronous processing, privileged reconciliation, delivered-order transition, authenticated PDF receipt, and provider delivery completed. Provider backlog/error signals were clear at close. | Do not repeat. Preserve the Telegram fixture as accepted evidence until separately authorized targeted purge. |
| Evolution | The authorized Evolution canary is completed and retained as sanitized accepted evidence, including duplicate delivery, unique processing to review, and supervisor reconciliation. | Do not repeat it or send provider traffic without separate future authorization. |
| Quarantine → Restore | Authorized rejection by supervisor/admin with lease, seller restore denial, and admin-only real Chromium UI restore; verified review transition, cleared retention, immutable admin event, and outbox delivery via repaired idempotency. | Retained as accepted baseline evidence. Restore gate returned to closed. |
| Expiry → Purge → Tombstone | Manifested synthetic expired quarantine proof claimed, original PDF and derivative PNG deleted by exact path, restore denied during active purge fence, detached hash tombstone retained, and subsequent identical-byte upload returned generic duplicate contract without resurrection or metadata leakage. | Retained as accepted baseline evidence. Cleanup gate returned to closed. |
| Privileged Replay | Supervisor and admin replay RPC verified; durable same-key idempotency with single effect; key collision and ineligible status rejected; seller/customer denied; positive Server Action replay via real Chromium moved dead letter to pending and natural scheduler completed delivery with exactly 1 projected message. | Retained as accepted baseline evidence. Privileged replay gate returned to closed. |

The historical baseline **before the later Telegram fixture** was processing `abandoned=1`, `completed=1`; outbox `abandoned=4`, `dead-letter=0`. The 2026-09-07 runtime audit found 5 `load` dead letters with missing originals (one purged proof, four review proofs), while outbox remained at 0. Under explicit human selection, migration `20260907120000_payment_proof_dead_letter_missing_original_disposition.sql` dispositioned them atomically: four review proofs entered ten-day quarantine, the purged proof remained purged, and all five queue rows became abandoned with immutable privileged audit. Current dead letters are 0/0. Do not merge these incident rows with preserved Telegram evidence or target them through general cleanup.

## Governing operational decisions

- All payment-proof capabilities are currently closed under the strict-stop condition; canonical intake is not an exception.
- Telegram admission requires both canonical intake and the separately startup-captured, default-closed `TELEGRAM_PAYMENT_PROOF_INGEST_ENABLED` gate. Local coverage proves the four-state truth table; no new live Telegram canary is authorized.
- Evolution is the sole production WhatsApp payment-proof authority. WhatsApp Cloud payment media remains non-admitting.
- Reconciliation authority is supervisor/admin-only: only active supervisors or admins may confirm amounts, link orders, reconcile/approve, reject, restore, inspect privileged diagnostics, or replay. Seller, inactive, and stale-session requests must safely deny without protected-state mutation.
- Use immutable image rollback for code defects. Capability rollback is close the relevant declarative gate and perform the approved Web-only recreation. Do not rewrite migrations, introduce legacy intake, or delete audit/hash/tombstone evidence.

## Exact next phases

| Phase | Outcome | Stop/authorization boundary |
| --- | --- | --- |
| A — handoff and authority correction | Complete the authoritative supervisor/admin-only database/RPC, Server Action, and UI contract with focused denial/success coverage; keep this sanitized handoff current. | Any authority bypass, raw-error leak, evidence privacy failure, or unhealthy circuit breaker stops progression. |
| B — Evolution WhatsApp E2E | Completed under its separate authorization; retain only sanitized accepted evidence. | Do not repeat the Evolution canary, provider send, or gate change without separate future authorization. |
| C — Telegram gate verification | The independent, startup-only Telegram gate is subordinate to canonical intake; local coverage proves all four combinations and process-start immutability. Cite the completed Telegram baseline without rerunning it. | No production Telegram exercise without separate future authorization. |
| D — lifecycle canaries | Separately authorize one quarantine-to-restore and one expiry-to-purge-to-tombstone test proof; require supervisor/admin authority, audit, idempotency, leases/fences, and bounded health observation. | Close lifecycle capability and recreate Web for any duplicate, missing audit/tombstone, unsafe transition, or degraded health. |
| E — privileged replay | Separately authorize one eligible non-sensitive dead-letter replay by a supervisor/admin; verify one-or-zero effect, idempotency, audit, read-only diagnostics, and seller denial. | No automatic or compensating replay. Close and recreate Web for a stop condition. |
| F — final production test, permanence, and release | After all implementation and pre-deployment suites are green, deploy one immutable candidate from this worktree and execute the owner-authorized bounded production test. Then the accountable human selects closed, named time-bound, or ongoing posture for every capability, including processing/reconciliation, with owner, thresholds, escalation, and review date. | Any stop condition triggers immediate gate closure and/or immutable-image rollback. Accepted evidence permits push and PR only. Merge stays prohibited until a distinct final explicit permission names the PR or commit. |

## Safe resume protocol

1. Run only from the designated worktree:

   ```bash
   cd /home/wilkin/proyectos/Asados-worktrees/client-payment-fix-deploy
   test "$(pwd -P)" = "/home/wilkin/proyectos/Asados-worktrees/client-payment-fix-deploy"
   test "$(git rev-parse --show-toplevel)" = "/home/wilkin/proyectos/Asados-worktrees/client-payment-fix-deploy"
   test "$(git branch --show-current)" = "fix/client-payment-flow-deploy"
   git status --short --branch
   ```

2. Treat `openspec/changes/complete-multichannel-payment-proof-rollout/` as expected authorized untracked work. Preserve it and do not edit it during documentation-only work unless separately authorized.
3. Do not deploy, apply migrations, recreate Web, change a gate, replay, restore, purge, clean up, or send a provider canary without explicit authorization for that exact operation.
4. Before an authorized window, check the project-owned environment file path, owner, and mode without printing values. Temporary environment links or copies into worktrees are strictly forbidden; linked worktrees rely on automatic canonical-checkout environment discovery in `scripts/run-selfhost-supabase-tests.sh` via Git common-dir and `worktree list --porcelain` fallback without copying or linking `.env`.
5. Record only sanitized evidence: approved window, role/owner reference, aggregate count/outcome, gate states, image/migration aliases, health/circuit-breaker result, rollback readiness, and redacted correlation aliases.

## Documentation and verification boundaries

Do not record PII, secrets, storage keys or URLs, raw payloads, customer content, phone numbers, full UUIDs, chat identifiers, delivery identifiers, or temporary-runner restoration. Do not recreate temporary historical runners. Their durable audit records—not scripts—remain the evidence.

Focused tests must precede broad validation for code work. This documentation-only update requires `git diff --check`; production verification remains separately authorized and is not implied by a clean documentation diff.

## Delivery governance

Receipt-driven development is `disabled/unmanaged`. Operational evidence is not a fabricated approval. No canary, test, deployment, or PR state authorizes merge.
