# Payment proof operations

> **Current answer (2026-09-07 audit):** all 8 operational gates are closed (`false`). The joint A/B/C audit found 5 processing dead letters, so the documented strict stop on `dead_letter > 0` was applied immediately. Completed canaries remain sanitized historical evidence; they do not override the current stop. Telegram evidence remains preserved.

## Quick operational path

1. Keep the current immutable Web image and all closed gates unchanged.
2. Before any future capability window, obtain explicit authorization, set only its declarative gate, and perform the approved Web-only recreation.
3. Confirm redacted gate diagnostics, healthy services with zero restarts, and ready/login HTTP 200 before the bounded operation; close the gate and recreate Web on completion or any stop condition.
4. After all implementation and pre-deployment checks are green, deploy one immutable candidate from the isolated worktree for the owner-authorized bounded production test; roll back immediately on a stop condition.
5. Push and open a PR only after the final evidence phase is accepted. **Merge still requires distinct explicit permission naming the PR or commit.**

## Current production posture

| Item | Current verified state |
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
| Audit health | Production Web and maintenance scheduler healthy with zero restarts; internal/public smoke passed; processing/outbox dead letters 0/0 after the authorized missing-original disposition; gates remain closed pending explicit reopening. |

Gate values are startup-captured declarative configuration. Missing, malformed, unreadable, cache-local, database, runtime-override, or live-process changes fail closed or have no effect. Do not treat this record as authorization to change any gate.

## Current local validation evidence

These checks validate the current checkout only. They do **not** establish production migration, immutable-image, deployment, gate-adoption, or canary completion.

- `npm run selfhost:config`: passed.
- Focused Telegram and restore gate validation: passed.
- Prior global Vitest baseline: 207 files passed and 1 skipped; 1,281 tests passed and 1 skipped.
- 2026-09-07 focused Vitest regression: passed, including direct financial-action authority and admitted-vs-reconciled behavior.
- 2026-09-07 isolated SQL pgTAP: restore 28/28, replay 45/45, replay concurrency 4/4, reconciliation 20/20, admin workflow 2/2, lifecycle 1/1.
- Real PostgREST v14.12 dispatcher idempotency integration: passed.
- `npx tsc --noEmit`: passed.
- Lint: passed with 0 errors and 0 warnings.
- `git diff --check`: passed.
- Local production build: passed on Next.js 16.3.0.
- Dependencies: npm-only local React/ReactDOM 19.2.4 tree; no pnpm.
- Test runner environments: local CLI runner (`npm run supabase:test`) runs against the local development stack (`127.0.0.1:54322`); self-hosted runner (`npm run selfhost:test:db` via `scripts/run-selfhost-supabase-tests.sh`) runs isolated tests in `asados-supabase-db` with automatic canonical environment discovery for linked worktrees and zero `.env` copying or symlinking.

## Completed baseline canaries

| Canary | Sanitized completed evidence | Boundary |
| --- | --- | --- |
| Web | Canonical admission, asynchronous processing, privileged reconciliation, delivered-order transition, authenticated PDF receipt, and directed cleanup were observed under a controlled window; the private original/PNG preview path and bounded queue/health observations completed successfully. | No customer content, storage paths, or full identifiers are retained here. This is not authorization for permanent processing or reconciliation. |
| Telegram | Duplicate and unique canonical admission branches, asynchronous processing, privileged reconciliation, delivered-order transition, authenticated PDF receipt, and provider delivery were observed under controlled windows. Provider backlog/error signals were clear at close. | The Telegram fixture is preserved solely as accepted evidence. Do not repeat this canary. A later targeted purge requires separate explicit authorization. |
| Evolution | The authorized Evolution canary is completed and retained as sanitized accepted evidence, including duplicate delivery, unique processing to review, and supervisor reconciliation. | Do not repeat this canary or send provider traffic without separate future authorization. |
| Quarantine → Restore | Authorized rejection by supervisor/admin with lease, seller restore denial, and admin-only real Chromium UI restore; verified review transition, cleared retention, immutable admin event, and outbox delivery via repaired idempotency. | Retained as accepted baseline evidence. Restore gate returned to closed. |
| Expiry → Purge → Tombstone | Manifested synthetic expired quarantine proof claimed, original PDF and derivative PNG deleted by exact path, restore denied during active purge fence, detached hash tombstone retained, and subsequent identical-byte upload returned generic duplicate contract without resurrection or metadata leakage. | Retained as accepted baseline evidence. Cleanup gate returned to closed. |
| Privileged Replay | Supervisor and admin replay RPC verified; durable same-key idempotency with single effect; key collision and ineligible status rejected; seller/customer denied; positive Server Action replay via real Chromium moved dead letter to pending and natural scheduler completed delivery with exactly 1 projected message. | Retained as accepted baseline evidence. Privileged replay gate returned to closed. |

These records retain aggregate outcomes only. Do not add payloads, tokens, phone numbers, storage keys or URLs, chat/provider/delivery identifiers, or full proof/order identifiers.

## Outbox message contract and Web idempotency

Payment-proof outbox payloads use audited `message_key` values only for new entries. Maintenance resolves those keys to fixed customer text before dispatch; symbolic keys are never sent to a provider. Legacy `payload.message` remains supported only when it is trimmed, non-empty, at most 4096 characters, and contains no control characters. Payloads that contain both fields or otherwise fail validation are permanently completed as `unsupported_payload` without dispatch.

For Web outbox messages, forward migration `20260906190000_payment_proof_web_message_idempotency.sql` adds a nullable `public.mensagens.external_id` text column and a non-partial unique index. Web outbox dispatch uses conflict-ignore upsert followed by an explicit post-upsert read confirming that `conversa_id`, `remetente`, `conteudo`, and `url_anexo` match the intended delivery. An exact match acknowledges success; a divergent binding returns permanent `delivery_conflict` without rewriting the existing message; missing rows or PostgREST read failures return retryable `delivery_failed`.

## Queue and historical baseline

At close of the authorized Telegram-gate deployment, processing and outbox dead letters were **0/0**. The 2026-09-07 joint audit later found **5/0**: all five processing failures were `load` failures with no current private original object. The accountable human selected **quarantine + abandonment**. Forward migration `20260907120000_payment_proof_dead_letter_missing_original_disposition.sql` added a privileged, idempotent, immutable-audit disposition. Four `review` proofs entered normal ten-day quarantine and their jobs became `abandoned`; the already-`purged` proof remained purged and only its job became `abandoned`. Current processing/outbox dead letters are again **0/0**. No replay, storage deletion, or tombstone reversal occurred. Gates remain closed until a separate reopening decision. The preserved Telegram fixture remains outside general cleanup scope.

## Gate and authority rules

- All payment-proof capabilities are currently closed under the strict-stop condition; canonical intake is not an exception.
- Telegram admission requires both startup-captured `TELEGRAM_PAYMENT_PROOF_INGEST_ENABLED` and canonical intake to be open. The four-state truth table is covered locally; no new live Telegram exercise is authorized by this runbook.
- Evolution is the only production WhatsApp payment-proof authority. WhatsApp Cloud payment media remains non-admitting.
- Confirmation, order linking, reconciliation/approval, rejection, lifecycle operations, diagnostics, and replay are **supervisor/admin-only**. Sellers, inactive users, and stale sessions must be denied without protected-state mutation.
- Gates change only through approved declarative configuration followed by approved Web recreation. Use immutable-image rollback for a code defect; never rewrite migrations or use a legacy proof fallback.

## Exact next phases

1. **Phase A — handoff and authority correction:** deliver and verify the supervisor/admin-only database, action, and UI contract; retain the sanitized handoff and closed-gate posture.
2. **Phase B — Evolution WhatsApp E2E:** completed under its separate authorization and retained as sanitized accepted evidence. Do not repeat the Evolution canary, provider send, or gate change without separate future authorization.
3. **Phase C — Telegram gate verification:** the startup-captured, default-closed Telegram gate is subordinate to canonical intake and its four gate combinations plus process-start immutability are locally covered. Cite, but do not rerun, the completed Telegram canary.
4. **Phase D — lifecycle canaries:** separately authorize one quarantine-to-restore and one expiry-to-purge-to-tombstone non-sensitive test case. Require supervisor/admin authority, audit, idempotency, leases/fences, and bounded health observation.
5. **Phase E — privileged replay:** separately authorize one eligible non-sensitive dead-letter replay with a supervisor/admin, idempotency, audit, read-only diagnostics, and no automatic follow-on replay.
6. **Phase F — final production test, permanence, and release:** after implementation and pre-deployment verification are green, deploy one immutable candidate for the authorized bounded production test with pre/post health and rollback readiness. Then an accountable human records for each capability whether it remains closed, is time-bounded, or is ongoing with owner, thresholds, escalation, and review date. Only after accepted evidence may the branch be pushed and a PR opened; merge needs separate final explicit permission.

## Operational preflight, observation, and rollback

Before an authorized window, verify the intended project-owned environment path/ownership/mode without printing values; temporary environment links or copies into worktrees are strictly forbidden and must not become configuration authority. For self-hosted SQL tests (`npm run selfhost:test:db` via `scripts/run-selfhost-supabase-tests.sh`), linked worktrees rely on automatic canonical-checkout environment discovery via Git common-dir and `worktree list --porcelain` fallback without copying or linking `.env`, separate from the local CLI development runner (`npm run supabase:test`). Record only a path alias and redacted effective diagnostic result.

Use bounded aggregate diagnostics: effective gate state/reason (including Telegram), queue and dead-letter counts, worker/maintenance/health and circuit-breaker state, restart count, and HTTP status. Do not use authenticated alert probes merely for connectivity because they can cause real notification effects.

Stop and close the affected capability through declarative configuration plus approved Web recreation for gate bypass, unauthorized mutation, duplicate work or notice, dead-letter growth, stale lease, missing audit/tombstone, unhealthy service/circuit breaker, raw sensitive-data disclosure, or material evidence/health mismatch. Preserve forward migrations, audit, hashes, and tombstones.

## Delivery governance

Receipt-driven development is `disabled/unmanaged`. This operational evidence is not a review approval. No deployment, recreation, gate opening, replay, restore, purge, cleanup, or permanent enablement is automatic.
