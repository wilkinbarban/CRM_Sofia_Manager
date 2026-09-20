# Archive Report: Sofia Customer Memory (`fatos_cliente`)

**Status: PASS** — change archived after successful archive-time spec composition.

- Change: `sofia-customer-memory`
- Archived to: `openspec/changes/archive/2026-09-20-sofia-customer-memory/`
- Archive date: 2026-09-20
- Artifact store: `openspec` (native SDD artifacts). No Engram archive observation was written by
  this archive task.
- Final task state consumed: **43/43 checked**, zero unchecked

## Artifacts read

| Artifact | Path | State |
| --- | --- | --- |
| Task completion | `tasks.md` | 43/43 checked, zero `- [ ]` |
| Apply progress | `apply-progress.md` | 1603 lines, ten cumulative slice records |
| Proposal | `proposal.md` | Read |
| Design | `design.md` | Read |
| Specs (deltas) | `specs/{memoria_cliente,client-navigation,crm_vendas,dashboard_admin,rag_conhecimento}/spec.md` | Read; all five composed |
| Verify report | — | Absent; not required (archive owns composition) |
| Archive report | `archive-report.md` | This file |

## Final task completion gate

Re-read `tasks.md` immediately before composition.

- Unchecked implementation tasks matching `^\s*- \[ \]`: **none** (`grep` exit 1).
- Checked tasks: **43**.
- No stale-checkbox reconciliation was needed or performed. `tasks.md` bytes were not modified, and
  neither were `proposal.md`, `design.md`, `apply-progress.md` or the five delta specs.

## Domains composed

| Domain | Canonical path | Operation | Requirements | Scenarios |
| --- | --- | --- | --- | --- |
| `memoria_cliente` | `openspec/specs/memoria_cliente/spec.md` | NEW capability (created) | 13 | 37 |
| `client-navigation` | `openspec/specs/client-navigation/spec.md` | ADDED (appended section) | 1 | 4 |
| `crm_vendas` | `openspec/specs/crm_vendas/spec.md` | ADDED (appended section) | 1 | 5 |
| `dashboard_admin` | `openspec/specs/dashboard_admin/spec.md` | ADDED (appended section) | 2 | 5 |
| `rag_conhecimento` | `openspec/specs/rag_conhecimento/spec.md` | ADDED (appended section) | 1 | 6 |

**Totals: 5 capabilities, 18 requirements, 57 scenarios. MODIFIED: none. REMOVED: none.** All four
deltas against existing capabilities declare `## ADDED Requirements` only, so no existing canonical
requirement text was replaced, and no canonical content unrelated to this change was touched.

Requirement names inserted:

- `memoria_cliente` (new file): `Per-customer typed fact store`; `Confidence bounded to inferred
  facts`; `Bounded auto-approval invariant`; `Permanent safety exclusion for restricao_alimentar`;
  `Single live fact per key with retained history`; `Auditable auto-approval without a dedicated
  column`; `RPC-only access with explicit grants`; `Operator review authority`; `Owner-scoped client
  access, correction, and refusal`; `Approved-facts-only prompt read surface`; `Extraction after each
  completed turn`; `At-most-once extraction with no retry`; `Default-closed feature gate`.
- `client-navigation`: `Customer facts section in /cliente/perfil`.
- `crm_vendas`: `Operator fact review surface for the selected customer`.
- `dashboard_admin`: `Anonymization removes the anonymized customer's facts`; `Total purge keeps
  removing facts through the cascade`.
- `rag_conhecimento`: `Per-customer facts block in Sofia prompt assembly`.

### Form of the write

`memoria_cliente` is a new capability. Its canonical file is the delta document verbatim: the delta
was already written in canonical form (`# memoria_cliente Specification` / `## Purpose` /
`## Requirements` / `### Requirement:` / `#### Scenario:`) and carried no ADDED/MODIFIED markers to
resolve, so the canonical bytes equal the delta bytes exactly (433 lines; byte equality confirmed by
direct comparison).

The four existing capabilities had mixed existing shape: `client-navigation` and `crm_vendas` held
**zero** `### Requirement:` blocks (they use `REQ-*` bullets and `#### Cenário` headings in pt-BR),
while `dashboard_admin` already carried 3 and `rag_conhecimento` already carried 5 (the latter from
the previous archive's section). In all four cases the repository convention demonstrated by the
previous archive was used: a new section, `## Requirements added by` followed by the change name in
backticks, appended at the end of each canonical file and holding the delta's requirement blocks
unchanged, rather than merging into another change's attributed section. This is the same shape the
already-archived `humanized-multichannel-sofia-responses` change used for `evolution_api`,
`portal_chat`, `integracoes` and `rag_conhecimento`.

Parity verified mechanically: for each of the four files the appended block is **byte-identical** to
the delta requirement/scenario block (scaffolding `# Delta for …`, the intro paragraph and the
`## ADDED Requirements` heading removed), the canonical prefix before the appended section is
unchanged, and `git diff --stat` shows insertions only.

## Archive sequencing — recorded constraint, deliberately not enforced

The archived `tasks.md` `## Recorded constraints carried into later phases` states that this change
should be archived **after** the applied same-domain changes, and that the earlier requirements must
be verified to survive. At archive time those changes are still active and unapplied:

- `openspec/changes/atendimento-preview-and-sofia-inbound-batching/specs/rag_conhecimento/spec.md`
- `openspec/changes/whatsapp-sofia-sleep-wake-control/specs/rag_conhecimento/spec.md`
- `openspec/changes/admin-estoque-security-deployment-hardening/specs/dashboard_admin/spec.md`

This archive therefore happens **out of the order recorded in `tasks.md`**. It is safe for what it
did — the ADDED-only composition neither replaced nor re-merged anything — and the survival check the
constraint asked for was run: `grep -c "### Requirement:" openspec/specs/rag_conhecimento/spec.md`
→ 6, with `Per-customer facts block in Sofia prompt assembly` present, and the
`2026-09-18-humanized-multichannel-sofia-responses` requirements preserved rather than re-merged.
The three still-active changes must append **after** this change when they compose; their deltas and
these canonical files now overlap at folder level and no native `sameDomainActiveChanges` signal
reported it.

## Delivery facts at close

- Delivered on `main` across ten slices, **43/43 tasks**, 2026-09-17 → 2026-09-20. Commits verified in
  history: `af2027d`, `9125a6d` (roadmap + hygiene), `d3e000b`, `f5b7ccc` (Web admission atomicity +
  response-pace helper), `53ebce8` (previous archive + this change's planning), `b7ddeaa`, `6f52fb0`,
  `7b6d075`, `f82a162`, `13916bf`, `56e3236` (slices 1–6), `7f8812a` (slice 7), `1fd37aa` (slice 8),
  `9164b5b` (slice 9), `321ca6a` (slice 10), then the three review-driven fixes `f0aa755`,
  `37495a7`, `a87fcf4`.
- Recorded PR mapping (from the delivery ledger; PR numbers are not carried in the commit subjects
  except `#168`–`#174`): `#166` roadmap+hygiene, `#167` Web admission atomicity + response-pace
  helper, `#168` previous archive + this change's planning, `#169`–`#174` slices 1–6, `#175` slice 7,
  `#176` slice 8, `#177` slice 9, `#178` slice 10, and tracker issue `#165`, closed. The three
  review-driven fixes are `#180` (Web idempotency key bound to content + server content-conflict
  refusal), `#181` (the admission function body terminator) and `#183` (Unicode separator hardening +
  closed-conversation refusal).
- Every slice was recorded with its own evidence in `apply-progress.md`, including the ones that
  initially failed or ran on a substitute host, and the `size:exception` slices 3, 5, 7, 8, 9 and 10
  (452 / 673 / 668 / 496 / 810 / 606 changed lines against the 400-line review budget).

## Migrations delivered

| Migration | Source | Production state |
| --- | --- | --- |
| `20260918010000_fatos_cliente_schema.sql` | slice 1 | applied |
| `20260918020000_fatos_cliente_rpcs.sql` | slices 2–3 | applied |
| `20260918030000_anonymize_fatos_cliente.sql` | slice 4 | applied |
| `20260919010000_web_admission_idempotency_content.sql` | review fix `#180` | applied |
| `20260920010000_fatos_cliente_valor_separadores.sql` | review fix `#183` | **pending the next deploy** |

All except the last are already applied in production. The last one is a forward-only migration that
drops and recreates the two `valor` constraints and recreates `revisar_fato_cliente` and
`corrigir_meu_fato_cliente`; its recorded pre-check is
`select count(*) from public.fatos_cliente where valor ~ '[\u2028\u2029]'` = **0** (the production
table is empty today), so the constraint swap cannot fail on existing rows.

The Web application is **not** deployed yet, so none of the TypeScript surfaces of this change
(extraction, prompt block, operator panel, client section) are live. The feature gate
`SOFIA_CUSTOMER_MEMORY_ENABLED` is closed by default in both deployment paths.

## Review

The delivered range was reviewed three times through the native review lifecycle:

| Lineage | Outcome | Findings |
| --- | --- | --- |
| `review-200e6892eed8ebe9` | `correction_required` | CRITICAL findings, corrected |
| `review-bb31b49f744f665c` | `correction_required` | CRITICAL findings, corrected |
| `review-3d475616574a4855` | **approved** (authority acknowledged and burned) | 13 informational, non-blocking |

The first two reviews raised three CRITICAL findings between them — the Web idempotency key reused
with different content, the Unicode line separators reaching the prompt, and the Web admission path
bypassing the closed-conversation rule. All three were fixed and merged: the key/content mismatch in
`#180`, and the Unicode separator leak plus the closed-conversation bypass in `#183`.

The third review approved the corrected tree and listed **13 informational, non-blocking findings: 1
risk, 4 readability, 4 reliability, 4 resilience**. They are separate later work. None of them
reopened the review, none blocked the archive, and none was folded into this composition.

### The thirteen informational findings, as published by the approval closure

| Id | Lens | Severity | Location |
| --- | --- | --- | --- |
| R1-001 | risk | SUGGESTION | `supabase/migrations/20260918020000_fatos_cliente_rpcs.sql:36-37` |
| R2-001 | readability | WARNING | `apps/web/src/app/actions/chat.ts:77` |
| R2-002 | readability | SUGGESTION | `apps/web/src/app/actions/chat.ts:155` |
| R2-003 | readability | WARNING | `supabase/migrations/20260920010000_fatos_cliente_valor_separadores.sql:13` |
| R2-004 | readability | WARNING | `apps/web/src/components/operator/OperatorClientFactsPanel.tsx:174` |
| R3-001 | reliability | WARNING | `supabase/migrations/20260920010000_fatos_cliente_valor_separadores.sql:13` |
| R3-002 | reliability | WARNING | `apps/web/src/lib/sofia/customer-memory-extraction.ts:82-96` |
| R3-003 | reliability | WARNING | `apps/web/src/lib/ai/openrouter.ts:314-318` |
| R3-004 | reliability | WARNING | `supabase/migrations/20260918020000_fatos_cliente_rpcs.sql:47-52` |
| R4-1 | resilience | WARNING | `apps/web/src/lib/sofia/inbound-batch-worker.ts:194` |
| R4-2 | resilience | SUGGESTION | `apps/web/src/lib/ai/openrouter.ts:314` |
| R4-3 | resilience | SUGGESTION | `apps/web/src/lib/sofia/inbound-batch-producer.ts:76` |
| R4-4 | resilience | SUGGESTION | `apps/web/src/components/chat/ChatContainer.tsx:758` |

Ids, lenses, severities and locations are transcribed from the approval closure the provider returned
when the third lineage reached `approved`. That closure carried no claim text, and the per-finding
payloads are not tracked artifacts, so this table is provenance rather than paraphrase. Two of them
align with limits this delivery had already recorded in prose: the prompt fetch ignoring a resolved
RPC error (`R3-003`, matching slice 7's F4) and the extraction lost when a process dies after
completion (`R4-1`, matching the worker hook's own comment).

## Follow-ups owed

Recorded during the work, not blockers:

1. **`registrar_fato_cliente` typed-error parity for a separator value.** The `#183` migration
   recreates only `revisar_fato_cliente` and `corrigir_meu_fato_cliente` with the U+2028/U+2029
   class inside their `22023` validation; a separator arriving through the backend writer still
   surfaces as the constraints' `23514` instead of the typed `22023`. The migration's own header
   records this.
2. **The operator read/write surface over `fatos_cliente` is not behind
   `SOFIA_CUSTOMER_MEMORY_ENABLED`.** That flag gates extraction and prompt injection only. Listing
   and reviewing facts is authorized by `verificarOperadorAutorizado()` plus the RPCs' own role
   check. This is a product decision, not a defect.
3. **The client section's post-write re-read failure path is untested by design choice.** If the
   post-write re-read fails, the section replaces the list with the read-error state — the
   conservative choice, recorded rather than silently accepted.
4. **Slice 7's recorded limits.** The RPC `error` field is ignored per design §7.5 (a resolved error
   degrades silently to an empty block), and the block footer is one physical line versus the
   design's wrapped display (the normative spec does not mandate wrapping).
5. **The deploy of the Web application**, which is the remaining step before any of the runtime
   surfaces are exercised in production.

## Destructive merge approvals or blockers

- Destructive merges (REMOVED requirements, large MODIFIED replacements): **none required**. No
  approval was requested, because all four deltas are ADDED-only and the fifth capability is new.
- Blockers remaining at archive time: **none**.

## Files written or moved

- Created: `openspec/specs/memoria_cliente/spec.md` (433 lines, byte-identical to the delta).
- Composed (appended section only): `openspec/specs/client-navigation/spec.md` (+41),
  `openspec/specs/crm_vendas/spec.md` (+50), `openspec/specs/dashboard_admin/spec.md` (+54),
  `openspec/specs/rag_conhecimento/spec.md` (+62). Total +207 insertions, 0 deletions.
- Moved (all nine artifacts, `git mv`): the change directory under `openspec/changes/` →
  `openspec/changes/archive/2026-09-20-sofia-customer-memory/` — `proposal.md`, `design.md`,
  `tasks.md`, `apply-progress.md` and the five delta specs under `specs/`.
- Written into the archive: `openspec/changes/archive/2026-09-20-sofia-customer-memory/archive-report.md`
  (this file).
- Not touched by archive: `proposal.md`, `design.md`, `tasks.md`, `apply-progress.md`, all five delta
  specs, all source files, migrations and tests. `apply-progress.md` retains its cumulative slice
  records unchanged, including their historical references to the change's pre-archive path.

## Evidence provenance

Verified directly from the working tree for this report: the 43/43 task gate, the ten slice sections,
the five delta files and their ADDED-only markers, the four canonical targets' prior content, the
byte-identical composition parity, the five migration files, the commit history above, the presence
of the three review lineages' local lifecycle state (the first two ending `correction_required`), and
the survival of the earlier `rag_conhecimento` requirements. Recorded from the delivery ledger rather
than re-verified here: the PR numbering, the production apply state of each migration, the production
pre-check count, the review finding counts by lens, and the thirteen finding ids, severities and
locations — the last two transcribed from the provider's approval closure, which is not a tracked
artifact.

## Next recommended

None — the change is closed. Owed follow-up: when
`atendimento-preview-and-sofia-inbound-batching`, `whatsapp-sofia-sleep-wake-control` and
`admin-estoque-security-deployment-hardening` compose, their deltas must append after this change's
sections, and a human should confirm the ADDED-only composition here did not hide a
same-concept parameterisation conflict in `rag_conhecimento`.
