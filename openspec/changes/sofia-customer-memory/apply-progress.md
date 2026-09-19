# Apply Progress: Sofia Customer Memory (`fatos_cliente`)

Cumulative progress for `openspec/changes/sofia-customer-memory`. Slices are appended, never
rewritten; earlier entries stay byte-identical.

## Delivery ledger

| Field | Value |
|-------|-------|
| Change | `sofia-customer-memory` |
| Artifact store | `openspec` (native status; session preflight also allows Engram, see persistence note) |
| Delivery strategy | `ask-on-risk` |
| Chain strategy (parent-resolved) | `stacked-to-main` |
| This run | **PR 1 of 10 — Slice 1: schema, constraints, and index set** |
| PR base | `main` |
| Slice forecast | ~215 lines |
| Slice measured | **213 authored lines** (68 migration + 142 suite + 3 harness) |

### Structured status consumed (native, read-only)

Re-consumed before any edit with
`gentle-ai sdd-status sofia-customer-memory --cwd /home/wilkin/proyectos/CRM_Sofia_Manager`:

- `schema: gentle-ai.sdd-status@2`, `store: openspec`, `next: apply`
- `apply: ready`, `verify: ready`, `archive: ready`, `tasks: 0/43 complete`
- `actionContext.mode: repo-local`, `workspaceRoot: /home/wilkin/proyectos/CRM_Sofia_Manager`,
  `allowedEditRoots: [/home/wilkin/proyectos/CRM_Sofia_Manager]`
- `applyState: ready`; no blocked reasons, no notes.

### Review Workload Gate

`tasks.md` carries `Decision needed before apply: Yes`, `Chained PRs recommended: Yes`,
`400-line budget risk: High`, `Chain strategy: pending`. The parent supplied the resolved delivery
path for this run: **`stacked-to-main`, PR 1 of 10, tasks 1–5 only**. Under that authorization the
gate is satisfied without inferring `size:exception`; the forecast table inside `tasks.md` was left
untouched because this phase owns only the task checkboxes.

## Slice 1 — Schema, constraints, and index set (tasks 1–5)

### Completed tasks and persisted checkbox state

Re-read after the final run; `grep -n '^- \[' openspec/changes/sofia-customer-memory/tasks.md`
shows lines 107–111 as `- [x]` and lines 115–176 as `- [ ]`:

- [x] 1. RED — `supabase/tests/sofia_customer_memory.sql` created with the guarded `\if`-include
      prelude, `plan`, shape assertions, and the harness registration.
- [x] 2. GREEN — `supabase/migrations/20260918010000_fatos_cliente_schema.sql` created.
- [x] 3. TRIANGULATE — the bounded auto-approval matrix (21 assertions).
- [x] 4. TRIANGULATE — index set, partial predicates, key reuse, and the ownership-transfer
      invariant (14 assertions).
- [x] 5. REFACTOR — `plan(87)` reconciled exactly, no duplicated assertion, no constraint expressed
      twice, recorded slice size.

### Files changed

| Path | Change | Lines |
|------|--------|-------|
| `supabase/migrations/20260918010000_fatos_cliente_schema.sql` | new | +68 |
| `supabase/tests/sofia_customer_memory.sql` | new | +142 |
| `scripts/run-local-sofia-sql-tests.sh` | suite added to `default_suites`; `usage()` "six" → "seven" | +2 / -1 |
| `openspec/changes/sofia-customer-memory/tasks.md` | tasks 1–5 checked off with in-line evidence | artifact |
| `openspec/changes/sofia-customer-memory/apply-progress.md` | new (this file) | artifact |

No file outside the authorized edit surface was touched. `design.md`, `proposal.md`, and the five
spec artifacts are unmodified. No application (TypeScript) code changed, so no `vitest` surface is
in scope for this slice.

### Schema content delivered (design §4.1/§5/§6.1/§8/§9.1/§14.1)

- 14 columns; `id uuid primary key default gen_random_uuid()`; `estado text not null default 'pendente'`.
- FKs: `cliente_id → public.clientes on delete cascade`, `origem_conversa_id → public.conversas on
  delete set null`, `substitui_id → public.fatos_cliente on delete set null` — exactly three, and
  **`revisado_por` carries none** (asserted as "exactly three foreign keys").
- `ck_fatos_cliente_tipo`, `ck_fatos_cliente_origem`, `ck_fatos_cliente_estado`,
  `ck_fatos_cliente_chave`, the four `valor` checks (`valor_nao_vazio` covering empty/whitespace and
  untrimmed, `valor_tamanho`, `valor_controle`, `valor_invisivel`), `ck_fatos_cliente_confianca`
  (origin rule + `0..1` range), `ck_fatos_cliente_revisao` (reviewer/time pairing), and
  `ck_fatos_cliente_aprovacao` carrying the **`0.85` literal**, excluding `tipo =
  'restricao_alimentar'`, and trusting **only `cliente` and `operador`** (`importado` absent from the
  constraint text).
- `uq_fatos_cliente_vigente` partial unique on `(cliente_id, tipo, chave) where estado in
  ('pendente','aprovado')`, plus the five supporting indexes (`fatos_cliente_prompt`,
  `fatos_cliente_revisao`, `fatos_cliente_auto_aprovados`, `fatos_cliente_origem_conversa`,
  `fatos_cliente_substitui`).
- `enable row level security` **without** `force`, no policy, `revoke all ... from public, anon,
  authenticated, service_role`.
- pt-BR `comment on table`, `comment on column` for `tipo`/`chave`/`valor`/`origem`/`estado`, and
  `comment on constraint` for the two central constraints.
- **No** `alter function ... owner to supabase_admin` statement: `expected_owner_transfers=8` in
  `scripts/run-local-sofia-sql-tests.sh:54` stayed correct and the harness proved it (`owner_transfers_removed=8`).

### TDD Cycle Evidence

| Cycle | Step | Command | Observed result |
|-------|------|---------|-----------------|
| 1 | RED | `bash scripts/run-local-sofia-sql-tests.sh supabase/tests/sofia_customer_memory.sql` | exit 1: `error: staged suite files are missing inside supabase_db_sofia-sql-d7916310 after restaging: missing staged file: /tmp/sofia-sql-suites-sofia-sql-d7916310/supabase/migrations/20260918010000_fatos_cliente_schema.sql` |
| 2 | GREEN | same command | `PASS sofia_customer_memory.sql (assertions=52 failed=0 psql_exit=0)`; `owner_transfers_removed=8` |
| 3 | TRIANGULATE (approval matrix) | same command | `plan(73)`; `PASS sofia_customer_memory.sql (assertions=73 failed=0 psql_exit=0)` |
| 4 | TRIANGULATE (indexes + key reuse) | same command | `plan(87)`; `PASS sofia_customer_memory.sql (assertions=87 failed=0 psql_exit=0)` |
| 5 | REFACTOR (final) | `bash scripts/run-local-sofia-sql-tests.sh` (whole default set) | `summary: suites=7 assertions=286 failed_assertions=0 failing_suites=0` / `all selected suites passed` |

Detail of the RED evidence: the harness stages the suite plus every relative `\ir` target and aborts
when one is missing, so the failure names the absent migration/table rather than reporting zero
assertions. That is the honest RED for a SQL task whose assertion surface cannot exist before the
DDL lands.

### Deviations from the design and from this slice's task text

1. **Guarded prelude covers one migration, not three.** Task 1 asks for the `\if`-include prelude for
   the three new migrations, but the harness preflight requires every `\ir` target to exist
   (`suite_staged_paths`/`ensure_staged_suite`), so including `20260918020000_fatos_cliente_rpcs.sql`
   and `20260918030000_anonymize_fatos_cliente.sql` now would make this slice's own suite
   unrunnable. The two remaining includes join the prelude in Slices 2 and 4, in the same commit
   that creates each file. No behavior of the finished change is affected.
2. **Index predicates asserted through `pg_get_indexdef` over `pg_index`, not `has_index`.** The
   repository's pgTAP image has no `has_index` usage anywhere, and `has_index` cannot express a
   partial predicate (`where estado = 'aprovado' and tipo <> 'observacao'`), which is precisely what
   task 4 requires. The exact index-name set, the uniqueness of `uq_fatos_cliente_vigente`, and every
   partial predicate are asserted instead; the ownership-transfer invariant is asserted by the
   harness itself (`owner_transfers_removed=8`, a hard failure when it drifts).
3. **`confianca numeric(3,2)` rounding boundary — recorded for verify, not silently accepted.**
   `numeric(3,2)` (proposal data shape) rounds an incoming `0.845…0.849` up to a stored `0.85`, which
   then satisfies `ck_fatos_cliente_aprovacao`. The stored value is at/above the bound, so the
   invariant "no stored approved fact below 0.85" holds, and the 0.84/0.85 scenarios pass exactly as
   specified. If the change wants the model's unrounded confidence to be the decision input, the
   column scale must change in a later migration. Slice 5 owns the extraction-side confidence and is
   the natural place to decide.
4. **`tasks.md` forecast table left as-is** (`Chain strategy: pending`, budget risk High): the parent
   supplied `stacked-to-main`, and this phase owns only the task checkboxes.

### Remaining tasks (unchanged, still unchecked)

38 unchecked tasks, `openspec/changes/sofia-customer-memory/tasks.md` lines 115–176
(`grep -n '^- \[ \]' openspec/changes/sofia-customer-memory/tasks.md` reproduces them exactly):

- Slice 2 — backend RPCs: tasks 6–10 (`supabase/migrations/20260918020000_fatos_cliente_rpcs.sql`).
- Slice 3 — operator/owner RPCs, grants, isolation: tasks 11–14 (same RPC migration file).
- Slice 4 — LGPD anonymization extension: tasks 15–18.
- Slice 5 — gate, helpers, extraction, deploy defaults: tasks 19–23.
- Slice 6 — worker post-completion hook: tasks 24–27.
- Slice 7 — approved-facts prompt block: tasks 28–31.
- Slice 8 — operator authorization move and review actions: tasks 32–35.
- Slice 9 — operator facts panel and `fatos` tab: tasks 36–39.
- Slice 10 — client facts section in `/cliente/perfil`: tasks 40–43.

Nothing was started in Slice 2 or later: no RPC migration, no TypeScript, no panel, no commit.

### Chain context (chained-pr / work-unit-commits contract)

Strategy `stacked-to-main`; one deliverable work unit per PR; tests and the harness registration stay
with the unit they verify. Chain order and boundary:

```text
main
 └── PR 1 (tasks 1-5)  📍 current  — schema, constraints, index set (~215 forecast / 213 measured)
      ├── PR 2 (tasks 6-10)   backend RPCs: write path + prompt read        depends on PR 1
      ├── PR 3 (tasks 11-14)  operator/owner RPCs, grants, isolation        depends on PR 2
      ├── PR 4 (tasks 15-18)  LGPD anonymization extension                 depends on PR 1
      ├── PR 5 (tasks 19-23)  gate + helpers + extraction + deploy defaults depends on PR 2
      ├── PR 6 (tasks 24-27)  worker post-completion hook                  depends on PR 5
      ├── PR 7 (tasks 28-31)  approved-facts prompt block                  depends on PR 3,5
      ├── PR 8 (tasks 32-35)  operator auth move + review actions          depends on PR 3
      ├── PR 9 (tasks 36-39)  operator facts panel + `fatos` tab           depends on PR 8
      └── PR 10 (tasks 40-43) client facts section in `/cliente/perfil`     depends on PR 3
```

- **Current PR**: 1 of 10, base `main`, ends at task 5. Out of scope for this PR: every task 6-43,
  all TypeScript, the RPC and anonymization migrations, and any commit.
- **Follow-up**: PR 2 (Slice 2, tasks 6-10) is the next slice and is the first to add functions to
  `20260918020000_fatos_cliente_rpcs.sql` and to extend the suite's guarded prelude.
- **Dependency note for reviewers**: PR 1 has no producer and no reader of its own. The table is
  additive and inert until the RPC migration (PR 2) and the gate (PR 5) exist, so it can land first
  and be reverted alone.
- **Review budget**: 213 authored additions+deletions (68 migration + 142 suite + 3 harness) against
  the 400-line budget; no `size:exception` is requested or needed.
- **Verification plan**: `bash scripts/run-local-sofia-sql-tests.sh supabase/tests/sofia_customer_memory.sql`
  (slice proof) and `bash scripts/run-local-sofia-sql-tests.sh` (whole default set, proves the new
  migration is inert for the six pre-existing suites and keeps `owner_transfers_removed=8`).
- **Runtime boundary**: this slice's harness is a **real** runtime boundary, not `N/A` — the pgTAP
  suite executes inside the harness's disposable local Supabase Postgres. There is no application
  runtime boundary in this slice because no application code changed.
- **Uncommitted**: the parent forbade committing; the unit is left in the working tree with the
  rollback boundary above stated independently of any commit.

### Workload / PR boundary

- PR 1 of 10 delivers exactly the schema slice; its rollback boundary is
  `20260918010000_fatos_cliente_schema.sql` plus the suite registration (reverting the migration
  removes the table, the constraints, and the indexes; no runtime behavior depends on it while the
  gate of Slice 5 does not exist yet).
- Measured PR-1 code diff: **213 lines** — at the ~215 forecast, 187 lines under the 400-line
  review budget. No `size:exception` is needed or requested.
- Files that must stay with this slice: the migration and its suite (the suite is the slice's only
  proof) and the harness registration that makes the suite part of the default run.

### Verification still owed by later phases

- Slice 1 has no `vitest` surface; the pgTAP harness is its runner, and it ran for real here
  (TAP output validated by the harness's own TAP::Parser).
- The account for later slices continues in this file, cumulatively.

## Slice 2 — Backend RPCs: write path and prompt read (tasks 6–10)

Appended cumulatively; the Slice 1 section above is untouched.

### Delivery ledger (this run)

| Field | Value |
|-------|-------|
| Change | `sofia-customer-memory` |
| Artifact store | `openspec` (native status is the lifecycle authority; no Engram write in this run) |
| Delivery strategy | `ask-on-risk` |
| Chain strategy (parent-resolved) | `stacked-to-main` |
| This run | **PR 2 of 10 — Slice 2: backend RPCs (write path + prompt read)** |
| PR base | `main` (chain; Slice 1 commit `5665370` is the parent work unit) |
| Slice forecast | ~205 lines |
| Slice measured | **263 authored lines** (140 migration + 122 suite additions + 1 plan line) |

### Structured status consumed (native, read-only)

Re-consumed before any edit with
`gentle-ai sdd-status sofia-customer-memory --cwd /home/wilkin/proyectos/CRM_Sofia_Manager`:

- `schema: gentle-ai.sdd-status@2`, `store: openspec`, `next: apply`
- `apply: ready`, `verify: ready`, `archive: ready`, `tasks: 5/43 complete`
- `actionContext.mode: repo-local`, `workspaceRoot: /home/wilkin/proyectos/CRM_Sofia_Manager`,
  `allowedEditRoots: [/home/wilkin/proyectos/CRM_Sofia_Manager]`
- `applyState: ready`; no blocked reasons, no notes.

### Review Workload Gate

`tasks.md` carries `Decision needed before apply: Yes`, `Chained PRs recommended: Yes`,
`400-line budget risk: High`, `Chain strategy: pending`. The parent supplied the resolved delivery
path for this run: **`stacked-to-main`, PR 2 of 10, tasks 6–10 only**. Under that authorization the
gate is satisfied without inferring `size:exception`; the forecast table inside `tasks.md` was left
untouched because this phase owns only the task checkboxes.

### Completed tasks and persisted checkbox state

Re-read after the final run; `grep -nE '^- \[[x ]\] ([0-9]+)\.' openspec/changes/sofia-customer-memory/tasks.md`
shows lines 107–111 (tasks 1–5) and lines 115–119 (tasks 6–10) as `- [x]`, and lines 123–176
(tasks 11–43) as `- [ ]`:

- [x] 6. RED — failing assertions for both backend functions, their ACLs, `prosecdef`/empty
      `search_path`, and the prompt-read semantics.
- [x] 7. GREEN — `supabase/migrations/20260918020000_fatos_cliente_rpcs.sql` created, plus its
      guarded `\ir` include in the same step.
- [x] 8. TRIANGULATE — provenance precedence, idempotent replay, supersession, and the same-key
      race through `dblink`.
- [x] 9. TRIANGULATE — refusal durability at `confianca = 1.00`.
- [x] 10. REFACTOR — no requested approval state, runtime table denial, `plan(146)` reconciled.

### Files changed

| Path | Change | Lines |
|------|--------|-------|
| `supabase/migrations/20260918020000_fatos_cliente_rpcs.sql` | new (two functions, comments, grants) | +140 |
| `supabase/tests/sofia_customer_memory.sql` | `dblink` extension + `to_regprocedure` guard + 59 new assertions, `plan(87)` → `plan(146)` | +122 / -1 |
| `openspec/changes/sofia-customer-memory/tasks.md` | tasks 6–10 checked off with in-line evidence | artifact |
| `openspec/changes/sofia-customer-memory/apply-progress.md` | this cumulative Slice 2 section | artifact |

No file outside the authorized edit surface was touched. `design.md`, `proposal.md`, the five spec
artifacts, the Slice 1 migration, and all application (TypeScript) code are unmodified.

### RPC content delivered (design §4.1, §4.7, §4.8, §9.2, §12.1, §12.2)

`registrar_fato_cliente(uuid,text,text,text,text,uuid,numeric,boolean)` returns
`table(fato_id uuid, estado text, substituido_id uuid)`:

- **No `p_estado` parameter.** The only state input is `p_forcar_pendente`, and the `case` derives
  `estado` exactly as §4.1 states; `ck_fatos_cliente_aprovacao` remains the sole authority for the
  `0.85` threshold and the `restricao_alimentar` exclusion.
- **Validation order** is authority (`42501 SOFIA_FATO_SERVICE_ROLE_REQUIRED`, checked through the
  `auth.jwt()` role exactly like `enqueue_sofia_inbound_message`) → argument shape
  (`22023 SOFIA_FATO_ENTRADA_INVALIDA` for the five enums/regex/value rules,
  `22023 SOFIA_FATO_CONFIANCA_INVALIDA`, `22023 SOFIA_FATO_CONVERSA_INVALIDA`) → existence
  (`P0002 SOFIA_FATO_CLIENTE_NAO_ENCONTRADO`). Every message is a bare `SOFIA_*` token with no
  custom `details`.
- **Concurrency** is
  `pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_cliente_id::text || '|' || p_tipo || '|' || p_chave, 91423))`
  followed by `select ... for update` on the live row.
- **Precedence** (§12.1) is rank `cliente=4 > operador=3 > importado=2 > ia=1`: a strictly lower
  rank returns the live row unchanged with `substituido_id = null` and writes nothing; equal rank
  with an identical `valor` is an idempotent no-op; otherwise the predecessor becomes `substituido`
  and the successor links it through `substitui_id`.
- **Refusal durability** (§12.2) forces `pendente` for an `ia` candidate whose normalized value
  matches an existing `rejeitado` row for the key when no live row exists; the refused row is never
  superseded.

`buscar_fatos_para_prompt(uuid,integer)` returns `table(tipo text, chave text, valor text)`:
service-role only, `p_limite` outside `1..20` → `22023`, `estado = 'aprovado' and tipo <> 'observacao'`,
`order by tipo, chave`, and an **unknown customer returns an empty set rather than `P0002`**.

Both functions are `language plpgsql security definer set search_path = ''` with fully qualified
references, pt-BR `comment on function`, and the exact §9.2 block
(`revoke all ... from public, anon, authenticated, service_role` then `grant execute ... to service_role`).
No `alter function ... owner to supabase_admin` was added, so `expected_owner_transfers=8` still holds
and the harness's own assertion proved it during the full run.

### TDD Cycle Evidence

| Cycle | Step | Command | Observed result |
|-------|------|---------|-----------------|
| 1 | RED (task 6) | `bash scripts/run-local-sofia-sql-tests.sh supabase/tests/sofia_customer_memory.sql` | exit 1: `plan(117)`, psql exit 3, `ERROR: function public.registrar_fato_cliente(unknown, ...) does not exist`, 11 `not ok` throws_ok assertions, `parse problem: Bad plan.  You planned 117 tests but ran 98`, `summary: suites=1 assertions=98 failed_assertions=11 failing_suites=1` |
| 2 | GREEN (task 7) | same command | `PASS sofia_customer_memory.sql (assertions=117 failed=0 psql_exit=0)` |
| 3 | TRIANGULATE (task 8) | same command | first attempt failed honestly: `ERROR: SOFIA_FATO_CLIENTE_NAO_ENCONTRADO` on the owner dblink connection, because a dblink session cannot see the suite's single uncommitted transaction; after creating the race customer in autocommit from the owner connection: `plan(136)`; `PASS sofia_customer_memory.sql (assertions=136 failed=0 psql_exit=0)` |
| 4 | TRIANGULATE (task 9) | same command | `plan(142)`; `PASS sofia_customer_memory.sql (assertions=142 failed=0 psql_exit=0)` |
| 5 | REFACTOR (task 10) | `bash scripts/run-local-sofia-sql-tests.sh` (whole default set) | `PASS sofia_customer_memory.sql (assertions=146 failed=0 psql_exit=0)`; `summary: suites=7 assertions=345 failed_assertions=0 failing_suites=0` / `all selected suites passed` |

The `plan(N)` values are the reconciled ones the suite actually executes (TAP::Parser checks
plan == tests, so a mismatch fails the run). The TypeScript runner (`vitest`) is **not** an evidence
surface for this slice: no application file changed, so no `vitest` command was run and none is claimed.

### Deviations from the design and from this slice's task text

1. **Guarded prelude include added in task 7, not task 6.** The harness stages the suite plus every
   relative `\ir` target and aborts in preflight when one is missing, so the include could not exist
   before the migration file did. Task 6's RED was therefore run against the suite-assertions-only
   state (the functions were genuinely absent, and the failure names them), and task 7 added the file
   and its include together. The include is guarded by
   `select not to_regprocedure('public.registrar_fato_cliente(uuid,text,text,text,text,uuid,numeric,boolean)') is not null`,
   the analogue of the Slice 1 `to_regclass` guard, so the self-hosted runner still replays it while
   the disposable local run skips it.
2. **The dblink race fixture is created by the owner connection.** The suite runs as one
   `begin ... rollback` transaction, and its `clientes` fixtures are invisible to other sessions, so
   `f1000000-…-0004` ("Corrida Concorrente") is inserted by the owner dblink connection in
   autocommit before `begin`, and the customer insert is not part of the assertion count. The first
   attempt with the uncommitted Slice 1 customer failed with
   `SOFIA_FATO_CLIENTE_NAO_ENCONTRADO`; that failure is recorded above rather than hidden.
3. **`p_forcar_pendente = null` is treated as false**, because the design's `case` expression is
   implemented verbatim (`when p_forcar_pendente then …` and a `NULL` condition never matches). No
   new error path was invented for it and no assertion claims one.
4. **Task 10 added four executable confirmation assertions** instead of a prose-only confirmation:
   `p_forcar_pendente = true` on a trusted origin lands `pendente`, the writer definition contains no
   `p_estado`, and a live `select * from public.fatos_cliente` is denied with `42501` for
   `authenticated` and for `service_role`. The catalog-level `table_privs_are` assertions from Slice 1
   remain the schema proof; these add the behavioral one.
5. **The refused row used by task 9 is produced by a raw `update ... set estado='rejeitado'`**, because
   `revisar_fato_cliente` is owned by Slice 3. The transition is exactly the one that function will
   perform (rejection keeps the row and frees the key), and it is labelled as such in the suite.
6. **`confianca numeric(3,2)` rounding still applies** to `p_confianca` (Slice 1 deviation 3):
   an incoming `0.845…0.849` is stored as `0.85`. Task 9's `1.00` and every other asserted value are
   exact at scale 2, so no assertion depends on the rounding. Slice 5 owns the extraction-side
   confidence and the decision to change the column scale.
7. **Measured size 263 lines, above the ~205 forecast.** The extra lines are the two function bodies
   with their pt-BR comments and the 59 assertions that make provenance precedence, refusal
   durability, and the race verifiable. It is inside the 400-line budget, so no `size:exception`
   is requested and no code was compressed to reach the forecast.

### Remaining tasks (unchanged, still unchecked)

33 unchecked tasks, `openspec/changes/sofia-customer-memory/tasks.md` lines 123–176
(`grep -n '^- \[ \]' openspec/changes/sofia-customer-memory/tasks.md` reproduces them exactly):

- Slice 3 — operator/owner RPCs, grants, isolation: tasks 11–14 (same RPC migration file).
- Slice 4 — LGPD anonymization extension: tasks 15–18.
- Slice 5 — gate, helpers, extraction, deploy defaults: tasks 19–23.
- Slice 6 — worker post-completion hook: tasks 24–27.
- Slice 7 — approved-facts prompt block: tasks 28–31.
- Slice 8 — operator authorization move and review actions: tasks 32–35.
- Slice 9 — operator facts panel and `fatos` tab: tasks 36–39.
- Slice 10 — client facts section in `/cliente/perfil`: tasks 40–43.

The five operator/owner functions of Slice 3 were **not** started: the migration file contains exactly
the two backend functions, and no operator gate, owner resolution, or `authenticated` grant exists yet.

### Chain context (chained-pr / work-unit-commits contract)

Strategy `stacked-to-main`; one deliverable work unit per PR; the migration and the assertions that
prove it stay in the same unit. Chain order and boundary:

```text
main
 └── PR 1 (tasks 1-5)  ✅ landed 5665370 — schema, constraints, index set
      └── PR 2 (tasks 6-10)  📍 current  — backend RPCs: write path + prompt read
           ├── PR 3 (tasks 11-14)  operator/owner RPCs, grants, isolation      depends on PR 2
           ├── PR 4 (tasks 15-18)  LGPD anonymization extension                 depends on PR 1
           ├── PR 5 (tasks 19-23)  gate + helpers + extraction + deploy defaults depends on PR 2
           ├── PR 6 (tasks 24-27)  worker post-completion hook                  depends on PR 5
           ├── PR 7 (tasks 28-31)  approved-facts prompt block                  depends on PR 3,5
           ├── PR 8 (tasks 32-35)  operator auth move + review actions          depends on PR 3
           ├── PR 9 (tasks 36-39)  operator facts panel + `fatos` tab           depends on PR 8
           └── PR 10 (tasks 40-43) client facts section in `/cliente/perfil`     depends on PR 3
```

- **Current PR**: 2 of 10, based on the Slice 1 work unit, ends at task 10. Out of scope for this PR:
  every task 11–43, all TypeScript, the anonymization migration, and any commit.
- **Follow-up**: PR 3 (Slice 3, tasks 11–14) extends the same RPC migration file with the five
  operator/owner functions and their `authenticated` grants, and appends their assertions to the same
  suite; it owns the `revisar_fato_cliente` transition that Slice 2 simulates with a raw update.
- **Rollback boundary**: reverting `20260918020000_fatos_cliente_rpcs.sql` leaves the table, the
  constraints, and the indexes intact and simply removes the only access surface, so the change
  returns to the inert state of PR 1. No runtime behavior depends on these functions while the
  Slice 5 gate does not exist.
- **Review budget**: 263 authored additions/deletions (140 migration + 122 suite + 1 plan line)
  against the 400-line budget; no `size:exception` is requested or needed.
- **Uncommitted**: the parent forbade committing; the unit is left in the working tree.

## Slice 3 — Operator and owner RPCs, grants, isolation (tasks 11–14)

Appended cumulatively; the Slice 1 and Slice 2 sections above are untouched.

### Delivery ledger (this run)

| Field | Value |
|-------|-------|
| Change | `sofia-customer-memory` |
| Artifact store | `openspec` (native status is the lifecycle authority; no Engram write in this run) |
| Delivery strategy | `ask-on-risk` |
| Chain strategy (parent-resolved) | `stacked-to-main` |
| This run | **PR 3 of 10 — Slice 3: five operator/owner RPCs + grants + isolation** |
| PR base | `main` (chain; Slice 2 commit `a794fb9` is the parent work unit) |
| Slice forecast | ~205 lines |
| Slice measured | **452 changed lines** (254 migration + 197 suite additions + 1 deletion) |

### Structured status consumed (native, read-only)

Re-consumed before any edit with
`gentle-ai sdd-status sofia-customer-memory --cwd /home/wilkin/proyectos/CRM_Sofia_Manager`:
`schema: gentle-ai.sdd-status@2`, `store: openspec`, `next: apply`, `apply: ready`,
`actionContext.mode: repo-local`, `allowedEditRoots: [/home/wilkin/proyectos/CRM_Sofia_Manager]`,
`applyState: ready`, `tasks: 10/43 complete`; no blocked reasons, no notes.

### Review Workload Gate — decision required

`tasks.md` carries `Decision needed before apply: Yes`, `Chained PRs recommended: Yes`,
`400-line budget risk: High`, `Chain strategy: pending`; the parent resolved `stacked-to-main` and
scoped this run to tasks 11–14. **The measured slice is 452 changed lines — 13% above the 400-line
budget and well above the ~205 forecast.** The overage is honest work, not padding:

- the migration adds **five** functions (the slice forecast ~205 for a slice that actually holds
  five RPCs plus their pt-BR comments and per-function `revoke`/`grant` blocks);
- the suite adds **76 assertions** because task 13 mandates the full ACL matrix
  (5 signatures × 3 roles), the complete §4.8 token set, both-way owner isolation, and the seven
  assertions that prove `corrigir`'s in-place semantics; the ACL matrix alone is 15 lines that
  cannot be dropped without losing the "per function signature, per role" requirement.

No comments, blank lines, docs, or tests were deleted to reach a number, and the code was not
restyled. Under `ask-on-risk` this is a delivery decision the parent must raise: accept
`size:exception` for PR 3, or split Slice 3 into an operator-surface PR and an owner-surface PR.

### Completed tasks and persisted checkbox state

Re-read after the final runs; `grep -oE '^- \[[x ]\] [0-9]+\.' openspec/changes/sofia-customer-memory/tasks.md`
shows tasks 1–14 as `- [x]` and tasks 15–43 as `- [ ]`:

- [x] 11. RED — failing assertions for all five functions (operator gate, four-state listing with
      provenance and order, review decisions, owner read/correction/refusal, error tokens).
- [x] 12. GREEN — the five functions added to `supabase/migrations/20260918020000_fatos_cliente_rpcs.sql`.
- [x] 13. TRIANGULATE — ACL matrix, `prosecdef`/empty `search_path`, §4.8 token matrix, anonymous
      rejection on every owner function, two-way owner isolation, reviewed-refusal shape parity.
- [x] 14. REFACTOR — shared advisory-key-lock expression proven by assertion, RLS enabled without
      `force`, `plan(222)` reconciled.

### Files changed

| Path | Change | Lines |
|------|--------|-------|
| `supabase/migrations/20260918020000_fatos_cliente_rpcs.sql` | + five operator/owner functions, pt-BR comments, `revoke`/`grant` | +254 |
| `supabase/tests/sofia_customer_memory.sql` | + `auth`/`perfis` fixtures, 76 assertions, `plan(146)` → `plan(222)` | +197 / -1 |
| `openspec/changes/sofia-customer-memory/tasks.md` | tasks 11–14 checked off with in-line evidence | artifact |
| `openspec/changes/sofia-customer-memory/apply-progress.md` | this cumulative Slice 3 section | artifact |

No file outside the authorized edit surface was touched. `design.md`, `proposal.md`, the five spec
artifacts, the Slice 1 migration, and all application (TypeScript) code are unmodified. No commit
was created.

### RPC content delivered (design §4.2–§4.6, §4.8, §9.2)

- `listar_fatos_cliente(uuid,text[],integer)` — operator gate via `public.tem_funcoes`
  (`admin`/`supervisor`/`vendedor`), all four states with provenance, `order by estado,
  atualizado_em desc`, `p_limite` validated in `1..500`, `p_estados` validated against the enum,
  unknown customer → `P0002 SOFIA_FATO_CLIENTE_NAO_ENCONTRADO`.
- `revisar_fato_cliente(uuid,text,text)` — `aprovar`/`rejeitar` keep `confianca`; `corrigir` stores
  the normalized value and sets `confianca = null`; all three record `revisado_por`/`revisado_em`;
  `rejeitado`/`substituido` → `22023 SOFIA_FATO_NAO_REVISAVEL`; unknown id →
  `P0002 SOFIA_FATO_NAO_ENCONTRADO`.
- `meus_fatos_cliente(integer)` — resolves the owner through `clientes.usuario_id = auth.uid()`,
  `42501 SOFIA_FATO_NAO_AUTENTICADO` when anonymous, approved non-`observacao` only, narrow
  projection (`fato_id, tipo, chave, valor, origem, criado_em, atualizado_em`).
- `corrigir_meu_fato_cliente(uuid,text)` — **in-place update, not a supersession**: sets
  `origem='cliente'`, `estado='aprovado'`, `confianca=null`, `origem_conversa_id=null`, leaves
  `revisado_por`/`revisado_em` untouched; `P0002` for a non-approved own fact and for a missing id,
  `42501 SOFIA_FATO_NAO_EXPOSTO` for an own `observacao`, `42501 SOFIA_FATO_NAO_AUTORIZADO` for
  another customer's fact.
- `recusar_meu_fato_cliente(uuid)` — `estado='rejeitado'`, retains the row, leaves `origem`,
  `confianca`, and `origem_conversa_id` unchanged; same ownership/`observacao` refusals.

Grants follow design §9.2 exactly: `grant execute ... to authenticated` only for the five;
`service_role` receives **no** EXECUTE on any operator/owner function; `anon`/`public` receive
nothing anywhere. All seven functions are `prosecdef` with an empty `search_path`. The migration
adds no `alter function ... owner to supabase_admin`, so `expected_owner_transfers=8` still holds.

### Slice 2 consistency check (parent note honoured)

Slice 2 simulated a refusal with a raw `update` because `revisar_fato_cliente` did not exist.
Slice 3 now produces a refusal through `revisar_fato_cliente` (`revisar_recusa`, `origem='operador'`,
`origem_conversa_id` set, `confianca` null) and asserts the same row shape Slice 2 expects:
`estado='rejeitado'`, `origem`/`confianca`/`origem_conversa_id` unchanged, exactly one rejected row,
zero superseded rows. The two paths cannot drift silently.

### TDD Cycle Evidence

**Sanctioned runner unavailable (honest limitation).**
`bash scripts/run-local-sofia-sql-tests.sh supabase/tests/sofia_customer_memory.sql` was attempted
three times and failed before any suite ran:
`error: disposable local Supabase failed to start` with `supabase_realtime/storage/pg_meta ...
unhealthy` and `supabase_studio ... starting` (host has ~3 GB RAM free and 27 containers already
running). This is reported as an **unmet evidence surface**, not a pass.

Because the slice's core is SQL, the RED/GREEN cycles were executed on the same upstream image the
harness uses (`public.ecr.aws/supabase/postgres:17.6.1.143`) with a minimal faithful scaffolding for
the objects the migrations reference (`auth.jwt()`, `public.tipo_funcao`, `public.perfis`,
`public.tem_funcoes`, `public.clientes`, `public.conversas`), the repo's real suite and real
migrations, and the harness's own psql flags:

`docker exec sofia-static-check psql --no-psqlrc --quiet --tuples-only --no-align --pset pager=off -v ON_ERROR_STOP=1 -d "postgresql://postgres:postgres@127.0.0.1:5432/postgres" -v runtime_dblink_conninfo=... -f /tmp/check/supabase/tests/sofia_customer_memory.sql`

| Cycle | Step | Migration staged | Observed result |
|-------|------|------------------|-----------------|
| 1 | RED (task 11) | slice-2-only (`git show HEAD:...`) | `1..222`, `ok=146`, `not ok=8`, psql exit 3, abort on `42883 function public.listar_fatos_cliente(unknown, unknown, integer) does not exist` |
| 2 | GREEN (task 12) | full slice-3 migration | `1..222`, `ok=222`, `not ok=0`, psql exit 0 |
| 3 | TRIANGULATE (task 13) | full | all ACL/provenance/isolation assertions inside the 222 pass |
| 4 | REFACTOR (task 14) | full | `plan(222)` equals the 222 executed assertions; final re-run `ok=222`, `not ok=0`, exit 0 |

The `plan(N)` values are the reconciled ones the suite actually executes; a plan/test mismatch would
have failed both the psql run and the harness's TAP::Parser. TypeScript `vitest` is **not** an
evidence surface for this slice: no application file changed.

**Three real defects the scratch runner caught and the suite now fixes** (recorded rather than
hidden): (1) `WITH ORDINALITY` cannot take a column definition list — rewritten as `with ordinality
as t` with `t.ordinality`; (2) direct `select`s on `public.fatos_cliente` inside the
`set local role authenticated` blocks were correctly denied — function calls now run as
`authenticated` and row inspections run after `reset role`; (3) an undefined `f2_id` psql variable
and untyped `:'var'` values (fixed with `::text`). Without a runner these would have shipped broken.

### Deviations from the design and from this slice's task text

1. **`meus_fatos_cliente` follows the §4.4 SQL signature (7 columns incl. `atualizado_em`), not the
   §4.4 prose**, which lists `atualizado_em` among the omitted columns while the signature includes
   it. The explicit signature was treated as authoritative; the test asserts the internal review
   chain (`confianca`, `revisado_por`, `revisado_em`, `substitui_id`, `origem_conversa_id`) is
   absent and does not assert `atualizado_em` absent. Flagged for verify/archive.
2. **The advisory-key-lock expression is kept byte-identical inline in both write paths** rather
   than factored into a helper, because PostgreSQL has no shared-expression macro and an extra
   `SECURITY DEFINER` helper would widen the spec's declared seven-function surface. An assertion
   proves `revisar_fato_cliente` and `registrar_fato_cliente` both carry
   `pg_catalog.hashtextextended(..., 91423)`, which is the property that matters for serialization.
   The same reasoning applies to the repeated value predicate: PostgreSQL cannot share it without a
   helper, so it is repeated verbatim (no divergent copy).
3. **Owner gate tests split calls and inspections across `reset role`.** `authenticated` correctly
   holds no table privilege, so the suite calls the RPCs as `authenticated` and inspects rows as the
   owner. This is fidelity to design §9.1, not a workaround.
4. **The sanctioned harness did not run.** The scratch runner is an equivalent PostgreSQL 17.6
   image with minimal scaffolding, not the repository harness; the whole default-suite regression
   run (`bash scripts/run-local-sofia-sql-tests.sh`) could not be executed and is owed.
5. **`tasks.md` forecast table left as-is**; this phase owns only the task checkboxes.

### Remaining tasks (still unchecked)

29 unchecked tasks, `grep -oE '^- \[ \] [0-9]+\.'` reproduces them: Slice 4 (15–18), Slice 5
(19–23), Slice 6 (24–27), Slice 7 (28–31), Slice 8 (32–35), Slice 9 (36–39), Slice 10 (40–43).

### Chain context (chained-pr / work-unit-commits contract)

```text
main
 └── PR 1 (tasks 1-5)  ✅ landed 5665370 — schema, constraints, index set
      └── PR 2 (tasks 6-10)  ✅ landed a794fb9 — backend RPCs
           └── PR 3 (tasks 11-14)  📍 current  — operator/owner RPCs, grants, isolation
                ├── PR 4 (tasks 15-18)  LGPD anonymization extension                 depends on PR 1
                ├── PR 5 (tasks 19-23)  gate + helpers + extraction + deploy defaults depends on PR 2
                ├── PR 6 (tasks 24-27)  worker post-completion hook                  depends on PR 5
                ├── PR 7 (tasks 28-31)  approved-facts prompt block                  depends on PR 3,5
                ├── PR 8 (tasks 32-35)  operator auth move + review actions          depends on PR 3
                ├── PR 9 (tasks 36-39)  operator facts panel + `fatos` tab           depends on PR 8
                └── PR 10 (tasks 40-43) client facts section in `/cliente/perfil`     depends on PR 3
```

- **Current PR**: 3 of 10, based on the Slice 2 work unit, ends at task 14. Out of scope for this
  PR: every task 15–43, all TypeScript, the anonymization migration, and any commit.
- **Follow-up**: PR 4 (Slice 4, tasks 15–18) and PR 5 (Slice 5, tasks 19–23) are unblocked by this
  PR only where they already depended on PR 1/2; PR 7 and PR 8 now depend on PR 3.
- **Rollback boundary**: reverting the slice-3 additions to `20260918020000_fatos_cliente_rpcs.sql`
  removes the five functions and their grants and returns the change to the PR 2 state; the table,
  its constraints, its indexes, the two backend functions, and the suite's Slice 1/2 assertions are
  untouched.
- **Review budget**: 452 changed lines against the 400-line budget. A `size:exception` is required,
  or Slice 3 must be split (operator surface vs owner surface).
- **Uncommitted**: the parent forbade committing; the unit is left in the working tree.

### Workload / PR boundary

- PR 3 of 10 delivers exactly the operator/owner RPC slice. The unit is cohesive: the five functions,
  their grants, and the assertions that prove them cannot be separated without leaving either an
  unverified authorization surface or a test file whose plan does not match its content.
- Measured PR-3 code diff: **452 lines** (254 migration + 197 suite additions + 1 deletion).
- Runtime boundary: the scratch PostgreSQL 17.6 runner executed the suite for real (222 assertions,
  TAP-shaped output validated by hand); the repository harness boundary is **owed**.

### Slice 3 — review budget exception and evidence status (parent, 2026-09-18)

**Accepted exception.** Slice 3 measured **452 changed lines** (254 migration + 197 suite + 1 deletion)
against the 400-line review budget, 13% over, and far above the ~205 forecast. The user explicitly
accepted `size:exception` for this slice. The overage is honest work rather than padding: five RPCs
plus a 76-assertion block, of which 15 assertions are the mandated per-signature ACL matrix
(5 signatures x 3 roles). No comment, test, or code was deleted or compressed to reach a smaller
number.

**Sanctioned evidence obtained.** The repository harness did run for this slice:

    bash scripts/run-local-sofia-sql-tests.sh supabase/tests/sofia_customer_memory.sql
    -> PASS sofia_customer_memory.sql (assertions=222 failed=0 psql_exit=0)

**Unmet evidence surface — full-set regression.** The harness's readiness gate is currently flaky on
this host and aborts `supabase start` on a different container each attempt (`storage`, `realtime`,
`studio`, `pg_meta`). Seven attempts produced exactly one successful start. Container logs show the
services themselves starting successfully — for example storage logs
`Server listening at http://127.0.0.1:5000` and `[Server] Started Successfully` while the Docker
healthcheck still reports `unhealthy` — so the failure is in the readiness race, not in the services.
The whole default suite set was therefore **not** re-run for this slice, and no claim is made that it
is green. Re-run `bash scripts/run-local-sofia-sql-tests.sh` once the host is quieter; the regression
surface is narrow, since this slice only appends functions to one migration and assertions to one
suite, and no other suite references `fatos_cliente`.

**Environment note.** This repository is the production deployment checkout: the running
`asados-supabase` compose project resolves to `ops/supabase/docker-compose.yml` in this very
directory, and 27 production containers share the host with the disposable harness. That resource
contention is the plausible cause of the readiness flakiness. Freeing the Docker build cache
(5.87 GB) converted a consistently failing start into an intermittently succeeding one.

---

## Slice 4 — LGPD anonymization extension (tasks 15–18)

Appended cumulatively; every Slice 1–3 byte above is untouched.

### Delivery ledger (this run)

| Field | Value |
|-------|-------|
| Change | `sofia-customer-memory` |
| Artifact store | `openspec` (native status is the lifecycle authority; no Engram write in this run) |
| Delivery strategy | `ask-on-risk` |
| Chain strategy (parent-resolved) | `stacked-to-main` |
| This run | **PR 4 of 10 — Slice 4: `anonymizar_usuario_admin` removes the customer's facts before unlinking the identity** |
| PR base | `main` (chain; depends only on Slice 1's `public.fatos_cliente` table) |
| Slice forecast | ~85 lines |
| Slice measured | **125 changed lines** (29 migration + 93 added + 3 deleted in the suite) |

### Structured status consumed (native, read-only)

Re-consumed before any edit with
`gentle-ai sdd-status sofia-customer-memory --cwd /home/wilkin/proyectos/CRM_Sofia_Manager`:
`schema: gentle-ai.sdd-status@2`, `store: openspec`, `next: apply`, `apply: ready`, `verify: ready`,
`archive: ready`, `actionContext.mode: repo-local`,
`allowedEditRoots: [/home/wilkin/proyectos/CRM_Sofia_Manager]`, `applyState: ready`,
`tasks: 14/43 complete`; no blocked reasons, no notes. Status granted no writes; the parent scoped
this run to tasks 15–18.

### Review Workload Gate

`tasks.md` still carries `Decision needed before apply: Yes`, `Chained PRs recommended: Yes`,
`400-line budget risk: High`, `Chain strategy: pending`. The parent resolved `stacked-to-main` and
assigned PR 4 of 10. **Measured: 125 changed lines — inside the 400-line budget, so no
`size:exception` is requested or needed for this slice.** The forecast was ~85; the overage is real
fixture and assertion work rather than padding (the ordering probe, the state-coverage fixtures, and
the negative control are three distinct obligations of task 17). No comment, blank line, test, or
documentation was deleted or compressed to reach any number.

### Completed tasks and persisted checkbox state

`grep -oE '^- \[[x ]\] [0-9]+\.' openspec/changes/sofia-customer-memory/tasks.md` re-read after the
final run shows **tasks 1–18 as `- [x]`** and tasks 19–43 as `- [ ]` (18 checked, 25 unchecked, 43
total):

- [x] 15. RED — the leak reproduced: 3 `not ok` of 51.
- [x] 16. GREEN — the migration plus the guarded include: 51 `ok`, 0 `not ok`.
- [x] 17. TRIANGULATE — ordering probe, state coverage, negative control, purge cascade: 56 `ok`.
- [x] 18. REFACTOR — own file, verbatim body proven, rollback pairing documented, `plan(56)` reconciled.

### Files changed

| Path | Change | Lines |
|------|--------|-------|
| `supabase/migrations/20260918030000_anonymize_fatos_cliente.sql` | new: `create or replace public.anonymizar_usuario_admin(uuid)` = the current body verbatim + exactly one `delete from public.fatos_cliente ...` immediately before the `clientes.usuario_id` update + the source `revoke`/`grant` line | +29 (new file) |
| `supabase/tests/admin_user_dual_deletion.sql` | + two guarded includes, + fixtures (users/perfis/clientes/facts), + the `BEFORE UPDATE` ordering probe, + 18 assertions, `plan(38)` → `plan(56)` | +93 / -3 |
| `openspec/changes/sofia-customer-memory/tasks.md` | tasks 15–18 checked with in-line evidence | artifact |
| `openspec/changes/sofia-customer-memory/apply-progress.md` | this cumulative Slice 4 section | artifact |

No file outside the authorized edit surface was touched. The Slice 1–3 migrations, the RPC migration,
`sofia_customer_memory.sql`, `design.md`, `proposal.md`, the five spec artifacts,
`scripts/run-local-sofia-sql-tests.sh`, and all application (TypeScript) code are unmodified. No
commit was created.

### The one statement added, and where

```sql
 -- Unica instrucao nova: antes de anular `usuario_id`, apagar os fatos do cliente alvo.
 delete from public.fatos_cliente f using public.clientes c where c.id=f.cliente_id and c.usuario_id=p_usuario_alvo_id;
```

It sits on the line immediately before
`update public.clientes set usuario_id=null,... where usuario_id=p_usuario_alvo_id;`. Machine-checked
in this run:

- `body preserved verbatim: True` — the reproduced body equals
  `supabase/migrations/20260826222000_dual_deletion_runtime_fixes.sql` lines 2–20 byte-for-byte after
  removing the one inserted statement;
- `new statements inserted inside the body: 1`;
- `delete immediately precedes the clientes update: True`;
- `acl line identical to the source: True` — the reproduced `revoke all ... / grant execute ...` line
  is byte-identical to line 36 of the source migration, which covers **both**
  `anonymizar_usuario_admin(uuid)` and `iniciar_purga_total_usuario_admin(uuid)`. Keeping the
  statement byte-identical is the literal reading of "preserve verbatim"; it is a no-op for the second
  function (`create or replace` already preserved its ACL) and is flagged here so a reviewer can ask
  for a narrowed pair if they prefer the migration to mention only the function it replaces.

Everything else the task requires is present unchanged: the `admin` authority check through
`public.tem_funcoes`, the anti-lockout rule, the target `for update` lock, the idempotent
`deletion_requested_at` early return, the anonymized-phone allocation loop, the `perfis` update, and
the `logs_auditoria` insert.

### TDD Cycle Evidence

Strict TDD is active (`openspec/config.yaml`: `strict_tdd: true`). SQL tasks have no `vitest` surface,
so RED/GREEN/TRIANGULATE/REFACTOR are the four tasks as ordered below; no TypeScript file changed, so
`vitest` is not on this slice's surface.

| Cycle | Step | Command | Observed result |
|-------|------|---------|-----------------|
| 1 | RED | `bash /tmp/slice4-run.sh red1` | `plan(51)`; 51 assertions ran; **3 `not ok`**, 48 `ok`, psql exit 0 → `# Looks like you failed 3 tests of 51`: `not ok 10 - normal mode deletes every fact of the anonymized customer`, `not ok 14 - the target facts were already deleted at the instant clientes.usuario_id was nulled` (probe value `2`), `not ok 16 - the idempotent second call deletes no additional fact` |
| 2 | GREEN | `bash /tmp/slice4-run.sh green` | `plan(51)`; **51 `ok`, 0 `not ok`**, psql exit 0 |
| 3 | TRIANGULATE | `bash /tmp/slice4-run.sh triangulate` | `plan(56)`; **56 `ok`, 0 `not ok`**, psql exit 0 — the 18 new assertions include the ordering probe, the pending/rejected/superseded coverage pair, the negative control triple, and the purge cascade pair |
| 4 | REFACTOR | `python3` verbatim/ordering checks + `git diff --check` + the TRIANGULATE run above | `body preserved verbatim: True`; `new statements inserted inside the body: 1`; `delete immediately precedes the clientes update: True`; `acl line identical to the source: True`; `no whitespace errors`; `plan(56)` = 56 executed assertions |

The RED failure is the real defect, not a missing-object abort: with the unextended function the
anonymized customer keeps its facts and the ordering probe records two facts still present at the
instant `usuario_id` was nulled. Assertions 13/17/18 (`the ordering probe observed exactly one identity
unlink`, `the idempotent second call never re-nulls the identity`, `the idempotent second call leaves
other customers untouched`) passed on RED too, which is what makes the three failures specific rather
than incidental.

#### The runner actually used, and why (exact reproduction recipe)

`scripts/run-selfhost-supabase-tests.sh` is this suite's designated runner, and its own preflight
refuses on this host:

```
$ bash scripts/run-selfhost-supabase-tests.sh supabase/tests/admin_user_dual_deletion.sql
pgTAP extension is unavailable in asados-supabase-db
selfhost_exit=1
```

`pgTAP` is not installed in the production `postgres` database
(`select count(*) from pg_extension where extname='pgtap'` → `0`), and installing an extension into
the production database is a production write that stays with the human, so it was not done.

The RED/GREEN cycles therefore ran through the designated runner's own flow, reproduced verbatim
against the same container and the same psql flags, with pgTAP installed **in the disposable clone
only**:

```bash
container=asados-supabase-db; db="asados_slice4_<label>_$$"
docker exec "$container" createdb -U postgres "$db"
docker exec "$container" sh -c "pg_dump -U supabase_admin --format=custom --exclude-schema=realtime postgres \
  | pg_restore -U supabase_admin -d '$db' --exit-on-error"
docker exec "$container" psql -U postgres -d "$db" -Atqc \
  'create extension if not exists pgtap; create extension if not exists dblink;'
docker exec "$container" sh -c "printf '\\\\ir tests/admin_user_dual_deletion.sql\n' > /tmp/slice4/run.sql"
docker exec "$container" psql --no-psqlrc --quiet --tuples-only --no-align --pset pager=off \
  -v ON_ERROR_STOP=1 -U supabase_admin -d "$db" -f /tmp/slice4/run.sql
# then: dropdb -U postgres --if-exists --force "$db" and rm -rf the staged tree
```

This is a genuine runtime boundary: the repository's real suite, the real migration files, the real
production schema cloned read-only from the live database (`pg_dump` only), the same
`public.ecr.aws/supabase/postgres` image, and the same psql invocation the harness uses. Each run
dropped its scratch database and staged tree afterwards; a re-check after the last run showed no
`asados_slice4%`/`asados_sql_test%` database and no `/tmp/slice4-suites*` directory left behind.

#### Evidence surfaces that are met, partially met, or unmet

1. **Met — clone runner (above):** RED 3 failures → GREEN 51/51 → TRIANGULATE 56/56, plus the
   machine-checked verbatim/ordering comparison. This is the evidence the four task checkboxes rest
   on.
2. **Partially met — repository-local harness.** Six `supabase start` attempts were made against
   `scripts/run-local-sofia-sql-tests.sh` (one direct, three in a retry loop, two more after pruning
   the Docker build cache). Five failed at the readiness race the parent already described —
   `supabase_storage_... container is not ready: unhealthy`, sometimes with `realtime`, `studio`, or
   `pg_meta` — and the harness reported `error: disposable local Supabase failed to start`. **One
   attempt did start**, ran the full migration chain twice (`initial supabase db reset` exit 0 in 98s
   and `supabase db reset before admin_user_dual_deletion.sql` exit 0 in 99s), staged 14 suite files,
   and then stopped at the suite's own plan line:

   ```
   admin_user_dual_deletion.sql:35: ERROR:  function plan(integer) does not exist
   select plan(56);
   FAIL admin_user_dual_deletion.sql (assertions=0 failed=0 psql_exit=3 tap_exit=1)
   ```

   That failure is **pre-existing and environmental, not a defect of this slice**: the disposable
   local stack ships pgTAP as an available extension but does not install it, and this suite never
   created it (unlike `supabase/tests/sofia_customer_memory.sql`, whose own prelude, added in Slice 1,
   does `create extension if not exists pgtap;`). It is also why this suite is absent from the
   harness's `default_suites` and why the tasks name the self-hosted runner for it. Adding
   `create extension` to the suite is outside this slice's authorized edit surface, so it was not
   done; it is recorded here as an option for the parent. Two useful facts did come out of that run:
   the new migration applies cleanly inside the full `supabase db reset` chain, and the harness's
   normalization printed `owner_transfers_removed=8`, so the new migration adds no
   `alter function ... owner to supabase_admin` transfer and the harness's own invariant still holds.
3. **Unmet — the designated self-hosted runner:** blocked by its `pgTAP extension is unavailable in
   asados-supabase-db` preflight, as quoted above. No claim is made that it would have passed.
4. **Not attempted — the whole default suite set.** The seven default suites do not reference
   `public.fatos_cliente` or `anonymizar_usuario_admin`, and this slice only adds a suite file change
   plus one function replacement, so the regression surface there is empty; the harness's flakiness
   made the attempt not worth the host cost. No claim is made that the default set is green.

### Deviations from the design and from this slice's task text

1. **A second guarded include (`20260918010000_fatos_cliente_schema.sql`) was added to the prelude.**
   Task 15 names only the anonymization include, but the suite inserts into `public.fatos_cliente` and
   the runners clone a database that does not contain the table yet, so without the schema include the
   suite cannot run outside a database where the migration was already applied. It follows the same
   `to_regclass` guard pattern as the pre-existing includes. Recorded rather than silently absorbed.
2. **The anonymization guard tests the function definition, not an object's existence.** The
   migration is `create or replace`, so `to_regclass`/`to_regprocedure` cannot distinguish "already
   applied" from "not applied": the guard is
   `position('fatos_cliente' in pg_get_functiondef('public.anonymizar_usuario_admin(uuid)'::regprocedure)) = 0`.
   It is false in the repository-local harness (chain already applied) and true in a clone, which is
   exactly the behaviour the two runners need.
3. **The ordering probe is a `BEFORE UPDATE` trigger with a `SECURITY DEFINER` function.** The probe
   must write a row from inside `anonymizar_usuario_admin`, whose owner is `postgres`
   (`select proowner::regrole` on the live database) while the harness's psql session user is
   `supabase_admin`; an invoker trigger would run as `postgres` and could not insert into a table
   owned by the session user. `SECURITY DEFINER` makes the trigger run as its own owner, which is the
   role that created the probe table in that session, so the probe works under both session roles. The
   probe table and the trigger function are created inside the suite's transaction and disappear with
   its final `rollback;`.
4. **`plan(38 + k)` resolved to `plan(56)`** — 38 pre-existing assertions plus 18 new ones. The count
   is asserted exactly and the plan matches the executed assertions.
5. **`tasks.md` forecast table left as-is** (`Chain strategy: pending`, budget risk High): the parent
   supplied `stacked-to-main`, and this phase owns only the task checkboxes.

### Remaining tasks (unchanged, still unchecked)

25 unchecked tasks, tasks 19–43, all of them in Slices 5–10
(`grep -n '^- \[ \]' openspec/changes/sofia-customer-memory/tasks.md` reproduces them exactly):

- [ ] 19. **RED:** Create failing `tests/unit/sofia-customer-memory.test.ts` and `tests/unit/sofia-customer-memory-extraction.test.ts` covering: `customerMemoryEnabled` strictness (`undefined`, `'false'`, `'TRUE'`, `'1'`, `'yes'`, `' true'` all false; only `'true'` true); `normalizarValor` (NFKC, invisible/bidi stripping, newline/tab collapsing, double-space collapsing, whitespace-only rejection, 500/501 boundary, control characters, discard-never-truncate); candidate validation (unknown `tipo`, bad `chave`, over-long `valor` discarded while valid siblings survive; `assunto !== 'cliente'` discards the whole response; dedupe by `(tipo, chave)`; 10-candidate cap); and extraction (gate closed → zero provider calls and zero RPC; gate open → exactly one provider call for a batch of several messages; provider failure → logged, zero facts, no throw, no retry, no second call; parse failure → zero facts; exact RPC arguments `p_origem: 'ia'`, `p_forcar_pendente: false`, the batch conversation id; one candidate's `23505`/`22023` not aborting its siblings; no `valor` in any log line). Evidence: `bash scripts/workspace-preflight.sh run -- vitest run tests/unit/sofia-customer-memory.test.ts tests/unit/sofia-customer-memory-extraction.test.ts` fails.
- [ ] 20–43. Slice 5 (gate, helpers, extraction, deploy defaults), Slice 6 (worker hook), Slice 7
  (prompt block), Slice 8 (operator auth move + review actions), Slice 9 (operator facts panel), and
  Slice 10 (client facts section) — none started, none touched.

### Chain context (chained-pr / work-unit-commits contract)

Strategy `stacked-to-main`; one deliverable work unit per PR; the migration, the fixtures, the probe,
and the assertions stay in the unit they verify.

```text
main
 └── PR 1 (tasks 1-5)  schema, constraints, index set            committed 5665370
      ├── PR 2 (tasks 6-10)   write path + prompt read RPCs      committed a794fb9
      ├── PR 3 (tasks 11-14)  operator/owner RPCs, isolation     committed 01f4c6c
      ├── PR 4 (tasks 15-18)  LGPD anonymization extension       📍 current (uncommitted)
      ├── PR 5 (tasks 19-23)  gate + helpers + extraction + deploy defaults
      ├── PR 6 (tasks 24-27)  worker post-completion hook
      ├── PR 7 (tasks 28-31)  approved-facts prompt block
      ├── PR 8 (tasks 32-35)  operator auth move + review actions
      ├── PR 9 (tasks 36-39)  operator facts panel + `fatos` tab
      └── PR 10 (tasks 40-43) client facts section in `/cliente/perfil`
```

- **Current PR**: 4 of 10, ends at task 18. Out of scope for this PR: every task 19–43, all
  TypeScript, the worker hook, the prompt block, both UI surfaces, and any commit.
- **Dependency note for reviewers**: this slice reads Slice 1's table and nothing else; it is
  independent of the RPC slices, so it can land before or after PR 2/3.
- **Rollback boundary**: revert `20260918030000_anonymize_fatos_cliente.sql` **together with**
  `public.fatos_cliente`. Reverting the deletion alone silently re-creates the anonymization leak,
  which is stated in the migration header and repeated in the REFACTOR task above.
- **Review budget**: 125 changed lines against the 400-line budget; no `size:exception` needed.
- **Verification plan**: re-run the clone-runner recipe above (RED/GREEN/TRIANGULATE as recorded), and
  once pgTAP is available to a sanctioned runner, `bash scripts/run-selfhost-supabase-tests.sh
  supabase/tests/admin_user_dual_deletion.sql` for the 56-assertion suite.
- **Runtime boundary**: real — the suite executes against a PostgreSQL clone of the live schema with
  `pgTAP` and the real migration files. There is no application runtime boundary in this slice because
  no application code changed.
- **Uncommitted**: the parent commits each slice; this unit is left in the working tree.

### Final-byte evidence anchor (2026-09-18)

The TRIANGULATE run below was repeated after the last edit to either file, so the numbers are
anchored to the exact bytes this slice leaves in the working tree:

| File | md5 |
|------|-----|
| `supabase/migrations/20260918030000_anonymize_fatos_cliente.sql` | `26724175c2900953f148fbb7ce72ee1d` |
| `supabase/tests/admin_user_dual_deletion.sql` | `2de5e577cc49620bcd8075770cdb6ed2` |

```
$ bash /tmp/slice4-run.sh final
1..56
ok=56 not_ok=0   # 56 'ok' lines, 0 'not ok' lines, no "Looks like you failed" banner, psql exit 0
```

### Slice 4 — evidence obtained, and a corrected false alarm (parent, 2026-09-18)

**The LGPD slice now has sanctioned evidence.**

    bash scripts/run-local-sofia-sql-tests.sh supabase/tests/admin_user_dual_deletion.sql
    initial supabase db reset -> exit=0 (32s)
    PASS admin_user_dual_deletion.sql (assertions=56 failed=0 psql_exit=0)
    all selected suites passed

**CORRECTION — the migration chain was never broken.** An earlier note in this file's history and
the parent's working conclusion claimed the three new `20260918*` migrations broke
`supabase db reset`, and that a production deploy would therefore fail. That claim was FALSE. It was
artefactual to the development host, which runs the production Compose stack (27 containers) on
7.8 GB and cannot reliably start the harness's own disposable stack. An A/B there appeared
decisive — `db reset` failed with the migrations and passed without them — but the difference was
resource contention, not SQL. Re-run on a host with headroom (16 CPU / 15.57 GiB), `db reset`
succeeds **with** the migrations in 32 seconds. The migrations are sound; no production risk exists.

The transferable lesson: a test failure on a saturated host masquerades as a code defect, and an A/B
run on that same host returns a false verdict, because control and treatment differ only by a factor
that interacts with resource pressure. Verify code-defect claims on a host with headroom.

**Suite fixes required to make this suite runnable at all.** This suite was never exercised by the
local harness (it is not in `default_suites`), and two pre-existing gaps hid behind that:

1. It never created the pgTAP extension. Fixed with an idempotent
   `create extension if not exists pgtap;`, matching all seven sibling suites.
2. It assumed a session that can switch to `supabase_admin`. The local harness connects as
   `postgres`, which is not a superuser under Supabase, so both `set role` and the three
   `set local role` sites failed with `42501`. Each is now guarded by
   `pg_has_role(current_user, 'supabase_admin', 'member')`, and the negative branch runs
   `reset role` rather than staying on `authenticated` — the switch genuinely has to escalate, since
   fixture inserts run after `set local role authenticated`.

Registering this suite in `default_suites` would keep the LGPD path exercised routinely; it was
deliberately left out of this slice to avoid widening the shared regression set.

---

## Slice 5 — Gate, helpers, extraction, deploy defaults (tasks 19–23)

Appended cumulatively; every Slice 1–4 byte above is untouched.

### Delivery ledger (this run)

| Field | Value |
|-------|-------|
| Change | `sofia-customer-memory` |
| Artifact store | `openspec` (native status is the lifecycle authority) + `engram` mirror (this run writes both, per `openspec/config.yaml` `persistence.mode: both`) |
| Delivery strategy | `ask-on-risk` |
| Chain strategy (parent-resolved) | `stacked-to-main` |
| This run | **PR 5 of 10 — Slice 5: runtime gate, pure helpers, provider helper, extraction, deploy defaults** |
| PR base | `main` (chain; depends on PR 2's RPCs for the persistence call, though this slice only needs their names) |
| Slice forecast | ~290 lines |
| Slice measured | **673 authored lines** (104 + 91 + 111 production, 150 + 204 tests, 13 tracked additions) |

### Structured status consumed (native, read-only)

Re-consumed before any edit with
`gentle-ai sdd-status sofia-customer-memory --cwd /home/wilkin/proyectos/CRM_Sofia_Manager`:
`schema: gentle-ai.sdd-status@2`, `store: openspec`, `next: apply`, `apply: ready`, `verify: ready`,
`archive: ready`, `actionContext.mode: repo-local`,
`workspaceRoot: /home/wilkin/proyectos/CRM_Sofia_Manager`,
`allowedEditRoots: [/home/wilkin/proyectos/CRM_Sofia_Manager]`, `applyState: ready`,
`taskProgress: 18/43 complete`; no blocked reasons, no notes. Status granted no writes; the parent
scoped this run to tasks 19–23 and supplied the resolved delivery path (`stacked-to-main`, PR 5 of
10, base `main`, PR 4 committed as `404151d`).

### Review Workload Gate — decision required (measured, not forecast)

`tasks.md` carries `Decision needed before apply: Yes`, `Chained PRs recommended: Yes`,
`400-line budget risk: High`, `Chain strategy: pending`. The parent resolved `stacked-to-main` and
scoped this run to tasks 19–23 with the instruction to keep the slice inside the 400-line budget and
near the ~290 forecast. **The measured slice is 673 authored lines: 68% above the 400-line budget
and 132% above the forecast.** The parent's `next_recommended` for this run is a delivery decision it
must raise with the user.

Where the lines actually are, and why they cannot be cut without losing required coverage:

| File | Lines | Why it is this size |
|------|-------|---------------------|
| `apps/web/src/lib/sofia/customer-memory.ts` | 104 | `FATO_TIPOS` + the five constants/interface + `normalizarValor` (NFKC, invisible/bidi stripping, newline/tab collapsing, double-space collapsing, trim, three discard rules) + `validarCandidatos` (five per-field rules, per-candidate discard, dedupe, 10-cap). Every rule in it is a named assertion in task 19. |
| `apps/web/src/lib/ai/llm-json.ts` | 91 | Two provider paths: the OmniRoute `business-economy` call and the legacy OpenRouter/DeepSeek resolution (`sk-or-` detection, `OPENROUTER_MODEL` from `obterConfiguracaoSistema`, `AbortSignal.timeout(timeoutMs)`, the two headers `openrouter.ts` sets). Task 20 names every one of those details; `openrouter.ts` convergence onto this helper is an explicit non-goal. |
| `apps/web/src/lib/sofia/customer-memory-extraction.ts` | 111 | `PROMPT_EXTRACAO` (§7.7 verbatim, 11 lines), `LoteExtraivel`, the gate read, the single provider call, tolerant JSON parsing, per-candidate persistence with its own try/catch, and the three log sites that must never carry a `valor`. |
| `tests/unit/sofia-customer-memory.test.ts` | 150 | 23 cases: the 12-value strictness table, 8 normalization properties, 7 candidate-validation properties, and 2 source-level boundary assertions. |
| `tests/unit/sofia-customer-memory-extraction.test.ts` | 204 | 23 cases across gate inertness, single-call-per-batch, exact RPC arguments, five failure paths, log hygiene, and the five adversarial cases task 22 names. |
| `inbound-batch-gates.ts` / `docker-compose.yml` / `scripts/deploy-web.sh` | +10 / +2 / +1 | The gate function and the two closed-by-default deployment paths. |

No comment, JSDoc block, blank line, test, or assertion was deleted or compressed to reach a number,
and no file was restyled (the review-budget rule forbids it). The forecast assumed a terse test
style; these suites are written in the readable style of `tests/unit/sofia-customer-memory*.test.ts`
siblings rather than the dense one-line style of the older `evolution-*` suites. **Recommendation:
accept `size:exception` for PR 5, or split Slice 5 into two PRs** (19 + 20 + 21 = gate, helpers,
provider helper, deploy defaults ≈ 358 lines; 22 + 23 = the adversarial/refactor pass over the
extraction suite). This run did not split mid-flight because the parent owns the PR boundary.

### Completed tasks and persisted checkbox state

Re-read after the final run; `grep -oE '^- \[[x ]\] [0-9]+\.' openspec/changes/sofia-customer-memory/tasks.md`
shows tasks 1–23 as `- [x]` and tasks 24–43 as `- [ ]` (23 checked, 20 unchecked, 43 total):

- [x] 19. RED — both failing suites created with the full task-19 coverage; run recorded as a real
      RED (`Failed to resolve import "@/lib/sofia/customer-memory"`).
- [x] 20. GREEN — `customerMemoryEnabled` + `customer-memory.ts` + `llm-json.ts` +
      `customer-memory-extraction.ts`; 38 tests green.
- [x] 21. GREEN — the deployment surface closed by default; `.env.example` recorded as **unresolved**
      (policy-blocked path, contents not invented).
- [x] 22. TRIANGULATE — five adversarial cases; 46 tests green.
- [x] 23. REFACTOR — single gate read, no direct table access, no `valor` in any log; related
      regression suites and `tsc`/`eslint`/`git diff --check` green; slice size recorded.

### Files changed

| Path | Change | Lines |
|------|--------|-------|
| `apps/web/src/lib/sofia/inbound-batch-gates.ts` | + `customerMemoryEnabled()` (strict `"true"`, same shape as the five existing gates) | +10 |
| `apps/web/src/lib/sofia/customer-memory.ts` | new: `FATO_TIPOS`, `normalizarValor`, `validarCandidatos` (pure, no I/O, no logging) | +104 |
| `apps/web/src/lib/ai/llm-json.ts` | new: `chamarModeloEconomicoJson` (OmniRoute economy, else legacy OpenRouter/DeepSeek; never throws) | +91 |
| `apps/web/src/lib/sofia/customer-memory-extraction.ts` | new: `PROMPT_EXTRACAO`, `LoteExtraivel`, `extrairFatosDoLote` | +111 |
| `tests/unit/sofia-customer-memory.test.ts` | new: 23 cases | +150 |
| `tests/unit/sofia-customer-memory-extraction.test.ts` | new: 23 cases | +204 |
| `docker-compose.yml` | + `SOFIA_CUSTOMER_MEMORY_ENABLED=${SOFIA_CUSTOMER_MEMORY_ENABLED:-false}` beside the Sofia batch gates | +2 |
| `scripts/deploy-web.sh` | + `SOFIA_CUSTOMER_MEMORY_ENABLED=false` in `close_operational_gates` | +1 |
| `.env.example` | **not modified** — policy-blocked path (see deviations) | 0 |
| `openspec/changes/sofia-customer-memory/tasks.md` | tasks 19–23 checked off with in-line evidence | artifact |
| `openspec/changes/sofia-customer-memory/apply-progress.md` | this cumulative Slice 5 section | artifact |

No file outside the authorized edit surface was touched. The migrations, both SQL suites,
`design.md`, `proposal.md`, the five spec artifacts, `inbound-batch-worker.ts` (Slice 6),
`openrouter.ts` (Slice 7), and every later slice's file are untouched. No commit was created.

### What each surface now does

- **Gate.** `customerMemoryEnabled(value = process.env.SOFIA_CUSTOMER_MEMORY_ENABLED)` returns
  `value === "true"`. `undefined`, `'false'`, `'TRUE'`, `'True'`, `'1'`, `'0'`, `'yes'`, `'on'`,
  `' true'`, `'true '` and `''` are all false; only the exact string `'true'` opens it.
- **`normalizarValor`.** Rejects non-strings, applies `NFKC`, strips `\u200B-\u200F`,
  `\u202A-\u202E`, `\u2066-\u2069`, `\uFEFF`, collapses `\r\n`/`\n`/`\r`/`\t` runs to one space,
  collapses runs of two or more spaces, trims, then discards empty/whitespace-only, `> 500`
  characters, or any remaining control character (`\u0000-\u001F`, `\u007F`). **Discard, never
  truncate**: a 501-character value returns `null`, not a 500-character lie.
- **`validarCandidatos`.** Requires `assunto === 'cliente'` (any other subject discards the whole
  response), then per candidate: `tipo` in the five values, `chave` matching
  `^[a-z0-9_]{1,64}$`, a non-null normalized `valor`, and a finite `confianca` in `0..1`. Invalid
  candidates are dropped individually with valid siblings surviving; dedupe by `(tipo, chave)` keeps
  the first; the batch is capped at 10.
- **`chamarModeloEconomicoJson`.** One function, two paths: OmniRoute `business-economy` when
  `AI_ROUTING_V2_ENABLED === 'true'`, otherwise the legacy resolution identical to `openrouter.ts`
  (`sk-or-` prefix detection, `deepseek-chat` or `OPENROUTER_MODEL` from `obterConfiguracaoSistema`,
  `AbortSignal.timeout(params.timeoutMs)`). JSON is requested through the prompt on **both** paths, so
  the parser is the only schema authority and the memory gate never depends on another gate. It never
  throws: any failure resolves to `null`.
- **`extrairFatosDoLote(supabase, lote)`.** Step 1 is the single gate read. Step 2 is exactly one
  `chamarModeloEconomicoJson({ system: PROMPT_EXTRACAO, user: lote.contexto, maxTokens: 400,
  timeoutMs: 5000 })` call for the whole batch — `lote.contexto` is the hoisted
  `formatBatchContext(c.members)` string, so extraction performs **no second DB read**. Step 3 parses
  (tolerating a fenced block or trailing text) and validates. Step 4 persists each candidate through
  `supabase.rpc('registrar_fato_cliente', { p_cliente_id, p_tipo, p_chave, p_valor, p_origem: 'ia',
  p_origem_conversa_id, p_confianca, p_forcar_pendente: false })` with **no client-side threshold
  check** — the state comes from the database invariant. Step 5 returns the count of persisted facts.
  The function never throws and never retries; `23505` and `22023` are logged by code and do not abort
  sibling candidates. The module contains no `.from(`, `.insert(`, or `.update(`: the RPC is the only
  write surface.

### TDD Cycle Evidence

Strict TDD is active (`openspec/config.yaml`: `strict_tdd: true`, runner `vitest`). Four cycles, in
the task order:

| Cycle | Step | Command | Observed result |
|-------|------|---------|-----------------|
| 1 | RED (task 19) | `bash scripts/workspace-preflight.sh run -- npx vitest run tests/unit/sofia-customer-memory.test.ts tests/unit/sofia-customer-memory-extraction.test.ts` | exit 1: `Test Files 2 failed (2)`, `Tests no tests`, `Error: Failed to resolve import "@/lib/sofia/customer-memory" from "tests/unit/sofia-customer-memory.test.ts". Does the file exist?` (and the same for `customer-memory-extraction`) |
| 2 | GREEN (task 20) | same command | `Test Files 2 passed (2)`, `Tests 38 passed (38)` |
| 3 | TRIANGULATE (task 22) | same command | first attempt of the added source-inspection assertions failed honestly (`ENOENT ... tests/unit/undefined`, because under the jsdom environment `fs.readFileSync` does not accept the jsdom `URL` instance; fixed by resolving with `node:path` against `process.cwd()`), then `Test Files 2 passed (2)`, `Tests 46 passed (46)` |
| 4 | REFACTOR (task 23) | suite command + `npx vitest run tests/unit/sofia-inbound-batch-worker.test.ts tests/unit/sofia-inbound-batch-maintenance-route.test.ts tests/unit/sofia-inbound-batch-maintenance-scheduler.test.ts tests/unit/phase8-operations.test.ts` + `npx tsc --noEmit -p apps/web/tsconfig.json` + `npx eslint <six files>` + `git diff --check` + `bash -n scripts/deploy-web.sh` | slice suite `46 passed (46)`; related suites `Test Files 4 passed (4)`, `Tests 82 passed (82)`; `tsc` no output, exit 0; `eslint` exit 0; `git diff --check` exit 0; `bash -n` exit 0 |

**Runner note (recorded, not hidden).** The literal command in the task text
(`bash scripts/workspace-preflight.sh run -- vitest run ...`) cannot start on this host:
`scripts/workspace-preflight.sh: line 110: exec: vitest: not found`, because the preflight `exec`s the
command directly and only an npm script puts `node_modules/.bin` on `PATH`. `npx vitest run ...` —
the same binary the repository's own `npm run test` invokes — is the runner used here. This is a
PATH detail, not a test failure.

**Evidence surfaces met / not attempted.**

1. **Met** — the two vitest suites with their real runner and real counts (RED 2 failed / 0 tests →
   GREEN 38 passed → TRIANGULATE 46 passed), plus the related-suite regression run and the
   `tsc`/`eslint`/`bash -n`/`git diff --check` checks. A SQL harness is not needed for this slice:
   the pgTAP surface belongs to Slices 1–4 and was not re-run.
2. **Not attempted** — the whole-repository `npm run test` and `npm run build`. Both are owned by
   later slices and by the whole-change verification table; no claim is made that either is green, and
   no result is invented for either.
3. **Unmet by policy** — the `.env.example` documentation line (below).

### Deviations from the design and from this slice's task text

1. **`.env.example` is unresolved, not written.** Task 21 permits exactly this outcome ("if that file
   cannot be read or does not exist, record it as unresolved rather than inventing contents"). The
   harness safety policy refuses the path for the `read` **and** `edit` tools
   (`Gentle AI safety policy blocked access to sensitive path: .../.env.example`), and no contents
   were invented and no policy bypass was attempted through the shell. The two deployment surfaces
   that actually close the gate (`docker-compose.yml` default `${SOFIA_CUSTOMER_MEMORY_ENABLED:-false}`
   and the `close_operational_gates` rollback line) are in place, so the gate is closed by default in
   production; only the template documentation is owed. This closes `design.md` §16 item 1 as
   "policy-blocked path", replacing its earlier "contents were not verified" wording.
2. **Two source-level boundary assertions were added instead of a prose-only REFACTOR claim**
   (task 23). They read the four modules from disk and assert that
   `process.env.SOFIA_CUSTOMER_MEMORY_ENABLED` occurs exactly once in the whole of `apps/web/src`
   (inside `customerMemoryEnabled()`), that the extraction, `llm-json`, and `customer-memory` modules
   never mention the variable, and that the extraction module contains no `.from(`/`.insert(`/`.update(`.
   They are executable proof of two task-23 obligations that would otherwise be reviewer-only claims.
3. **`LoteExtraivel` is declared in the extraction module and types `canal` inline** as
   `'telegram' | 'whatsapp' | 'web'`, because the worker's `Channel` type is module-private
   (`inbound-batch-worker.ts:10`). Slice 6 can map its local `Channel` into this structural type
   without introducing a cross-module type dependency, which is also why the divergence cannot leak.
4. **`chamarModeloEconomicoJson` swallows every failure and returns `null`**, and
   `extrairFatosDoLote` handles both `null` and a thrown rejection. The design's §7.4 step 5 requires
   the failure to be logged once with a token and a batch id; keeping the helper silent and logging in
   the extraction module means exactly one log line per failure and no leaked provider message (a
   provider error can contain a `valor`, and a test proves it never reaches the log).
5. **The dedupe keeps the first candidate for a `(tipo, chave)` pair.** Task 19 says "dedupe by
   `(tipo, chave)`" without fixing which wins; first-wins is the deterministic choice, is asserted,
   and cannot promote a later, unvalidated duplicate over the earlier validated one.
6. **The adversarial "ignore as instruções" case asserts the schema boundary, not a model behaviour.**
   The provider response in that test carries an out-of-enum `tipo` and a duplicate key; the assertion
   is that only the schema-validated, first-seen candidate reaches the RPC. No claim is made that a
   model can be talked out of anything.
7. **`tasks.md` forecast table left as-is** (`Chain strategy: pending`, budget risk High): the parent
   supplied `stacked-to-main`, and this phase owns only the task checkboxes.

### Remaining tasks (unchanged, still unchecked)

20 unchecked tasks, `openspec/changes/sofia-customer-memory/tasks.md` lines 143–176
(`grep -n '^- \[ \]' openspec/changes/sofia-customer-memory/tasks.md` reproduces them exactly):

- Slice 6 — worker post-completion hook: tasks 24–27 (`inbound-batch-worker.ts`,
  `tests/unit/sofia-inbound-batch-worker.test.ts`). It owns the `extractFacts?` dep, the deferred drain
  loop, and the at-most-once comment; it consumes `LoteExtraivel` and `extrairFatosDoLote` from this
  slice and is the first production caller of both.
- Slice 7 — approved-facts prompt block: tasks 28–31 (extends `customer-memory.ts` with
  `agruparFatosParaPrompt`, edits `openrouter.ts`).
- Slice 8 — operator authorization move and review actions: tasks 32–35.
- Slice 9 — operator facts panel and `fatos` tab: tasks 36–39.
- Slice 10 — client facts section in `/cliente/perfil`: tasks 40–43.

Nothing in Slices 6–10 was started: `inbound-batch-worker.ts`, `openrouter.ts`,
`app/actions/atendimento.ts`, both UI surfaces, and the worker suite are byte-unchanged by this run.

### Chain context (chained-pr / work-unit-commits contract)

Strategy `stacked-to-main`; one deliverable work unit per PR; tests stay with the unit they verify.

```text
main
 ├── PR 1 (tasks 1-5)   committed 5665370 — schema, constraints, index set
 ├── PR 2 (tasks 6-10)  committed a794fb9 — backend RPCs
 ├── PR 3 (tasks 11-14) committed 01f4c6c — operator/owner RPCs, isolation
 ├── PR 4 (tasks 15-18) committed 404151d — LGPD anonymization extension
 └── PR 5 (tasks 19-23) 📍 current (uncommitted) — gate + helpers + extraction + deploy defaults
      ├── PR 6 (tasks 24-27)  worker post-completion hook                  depends on PR 5
      ├── PR 7 (tasks 28-31)  approved-facts prompt block                  depends on PR 3,5
      ├── PR 8 (tasks 32-35)  operator auth move + review actions          depends on PR 3
      ├── PR 9 (tasks 36-39)  operator facts panel + `fatos` tab           depends on PR 8
      └── PR 10 (tasks 40-43) client facts section in `/cliente/perfil`     depends on PR 3
```

- **Current PR**: 5 of 10, base `main`, ends at task 23. Out of scope for this PR: every task 24–43,
  the worker hook, the prompt block, both UI surfaces, and any commit.
- **Dependency note for reviewers**: this slice ships no production caller of `extrairFatosDoLote` —
  the gate is closed by default in both deployment paths, and Slice 6 is what wires the worker hook.
  Nothing in this PR changes existing runtime behaviour: `inbound-batch-gates.ts` is the only
  pre-existing production file touched, and it only gained an unused-by-default function.
- **Rollback boundary**: revert the three new modules, the two test files, the `docker-compose.yml`
  line, and the `deploy-web.sh` line; the change returns to the PR 4 state and the memory feature
  has no runtime surface at all. The gate being closed by default (`:-false`, and the explicit
  `=false` in `close_operational_gates`) means no rollback window depends on an env change landing.
- **Review budget**: 673 authored lines against the 400-line budget — a `size:exception` decision (or
  a 2-PR split of the slice) is required and is recorded above.
- **Uncommitted**: the parent commits each slice; this unit is left in the working tree.

### Workload / PR boundary

- PR 5 of 10 delivers exactly the gate, the pure helpers, the provider helper, the extraction
  function, and the closed-by-default deployment surface. The unit is cohesive: the extraction suite
  cannot be split from the gate it exercises without leaving either an untested gate or a test file
  whose subject is absent, and the deployment lines exist precisely to default-close the gate they
  name.
- Measured PR-5 code diff: **673 lines** = 319 authored production lines (306 in the three new
  modules + 13 tracked additions: the gate function and the two config lines) + 354 test lines.

  Verified counts: `wc -l` reports 104 + 91 + 111 = 306 production lines in the three new modules and
  150 + 204 = 354 test lines; `git diff --numstat` reports +10 (`inbound-batch-gates.ts`), +2
  (`docker-compose.yml`), +1 (`scripts/deploy-web.sh`). 306 + 354 + 13 = **673**.
- Runtime boundary: real — the vitest suites execute the actual gate, the actual normalization and
  validation, and the actual extraction function against injected provider and Supabase fakes; the
  only surfaces not exercised end to end are the live provider HTTP call and the real RPC.
- Verification owed to later phases: the whole-repository `npm run test` and the `npm run build`
  integration check (the change's own verification table), plus a controlled-window enablement smoke
  described in `design.md` §17.

### Final-byte evidence anchor (2026-09-18)

The slice suite was re-run after the last edit to any of these files, so the counts are anchored to
the exact bytes this slice leaves in the working tree (`Tests 46 passed (46)`):

| File | md5 |
|------|-----|
| `apps/web/src/lib/sofia/customer-memory.ts` | `f3dbedf875b840394a4d3d0f7be852b1` |
| `apps/web/src/lib/ai/llm-json.ts` | `ca2ca29a2abb3c26346e2ffc2ac3c194` |
| `apps/web/src/lib/sofia/customer-memory-extraction.ts` | `6eed98ee83b4b19e9045af71f02b45a0` |
| `apps/web/src/lib/sofia/inbound-batch-gates.ts` | `464509033a90c21143a960e2dc390403` |
| `tests/unit/sofia-customer-memory.test.ts` | `78a2dbfee0db1f3339d66edb50d6527b` |
| `tests/unit/sofia-customer-memory-extraction.test.ts` | `c0dc0015d137dbae572785144ff6c4cf` |

Native status re-consumed after the run (read-only, native is the lifecycle authority):
`schema: gentle-ai.sdd-status@2`, `next: apply`, `apply: ready`, `verify: ready`, `archive: ready`,
`tasks: 23/43 complete`, `applyState: ready`, no blocked reasons. The remaining 20 tasks are real
unimplemented work (Slices 6-10), not bookkeeping: `next: apply` is correct.

### Slice 5 — review budget exception and `.env.example` resolution (parent, 2026-09-18)

**Accepted exception.** Slice 5 measured **673 authored lines** (319 production: 306 across three new
modules plus 13 tracked additions; 354 test lines) against the 400-line review budget, 68% over, and
well above the ~290 forecast. The user explicitly accepted `size:exception`. The overage is structural
rather than padding: the slice creates three production modules and a suite carrying 46 assertions that
the task list itself specifies. No comment, test, or code was deleted or compressed to reach a smaller
number. Note for contrast: `restricao_alimentar` is never auto-approved and `normalizarValor` discards
an invalid value rather than truncating it, because a 500-character truncation would misrepresent what
the customer actually said — both are correctness requirements that cost lines.

**`.env.example` resolved by the parent.** Task 21 asked for `SOFIA_CUSTOMER_MEMORY_ENABLED=false` to be
documented there. The apply executor could not read or edit the path (its safety policy classifies it as
sensitive), so it recorded the item as unresolved. The parent documented it directly: the file already
documents six `*_ENABLED` gates for other subsystems but carried none of Sofia's, so the gate was added
in its own commented group at the end. `git check-ignore` confirms the path remains tracked, not
ignored. Both deployment paths still close the gate by default, and they are what actually enforce it.

**Evidence.** 46 Vitest cases pass across the two new suites, reproduced by the parent with
`npx vitest run tests/unit/sofia-customer-memory.test.ts tests/unit/sofia-customer-memory-extraction.test.ts`
-> `Test Files 2 passed (2), Tests 46 passed (46)`. The runner note in the slice record stands: the
literal `scripts/workspace-preflight.sh run -- vitest run` form cannot start on this host because the
preflight execs without `node_modules/.bin` on `PATH`; `npx vitest run` is the working equivalent of the
repository's own `npm run test`.

## Slice 6 — Worker post-completion extraction hook (tasks 24–27)

### Delivery ledger (this run)

- **Tasks:** 24–27, persisted as `- [x]` in `tasks.md` with inline `**Evidence (2026-09-19):**` clauses.
- **Files:** `apps/web/src/lib/sofia/inbound-batch-worker.ts` (+31/−3) and
  `tests/unit/sofia-inbound-batch-worker.test.ts` (+166/−0) = **200 changed lines** against the
  400-line budget.
- **Observed by the parent:** suite `Tests 83 passed (83)`; with the payment-proof harness guard,
  `Tests 112 passed (112)`; `npx tsc --noEmit -p apps/web/tsconfig.json` no errors; `npm run lint`
  exit 0.
- **Independent verification:** a separate read-only verifier agent ran the four commands and answered
  five structural questions from the source. It confirmed exactly two `lotesCompletos.push` sites
  (lines 134 and 161), the drain at line 194 after the delivery `while` loop (169–192) and before
  `return out`, that `executarHookExtracao` cannot mutate `BatchCounts`, and that the worker reads the
  customer-memory gate **zero** times.

### TDD Cycle Evidence

- **RED (re-derived, not reported).** With the implementation temporarily stashed
  (`git stash push apps/web/src/lib/sofia/inbound-batch-worker.ts`) the suite fails with **10 failing
  cases**: `extracts facts once with the completed batch payload after a paced completion`, the same
  `after a legacy completion`, `keeps the completion counts and the pass alive when extraction rejects`,
  `never extracts a batch before its own delivery attempt in the same pass`, `pushes exactly one
  completed batch per batch on the runtime-on path`, the same `on the runtime-off path`, `never
  re-drains a batch completed by a previous pass`, `drains after the delivery loop once the generation
  lease and the typing handle are released`, `drains only after the WhatsApp presence handle was
  released`, and `wires the production extraction dependency into the worker deps`. The implementation
  was then restored from the stash and the suite went green again, so the ten names above are the
  unambiguous falsification set for this slice.
- **GREEN.** `Test Files 1 passed (1)`, `Tests 83 passed (83)` (73 before the slice).
- **TRIANGULATE.** Ordering, single-push and no-re-drain assertions run through the worker's own pass
  loop; the honest-semantics comment ships at the hook with no fence claimed.
- **REFACTOR.** 83 unchanged, plus `tsc` clean and `npm run lint` exit 0.

### Deviations, honest limits and reviewer notes

1. **The negative assertions are negative by nature.** `expect(extractFacts).not.toHaveBeenCalled()`
   would also pass if the hook did not exist. They are corroborated by the positive
   `toHaveBeenCalledTimes(1)` / `toHaveBeenCalledWith(completedLote)` assertions, which the RED run
   above proves fail without the hook. Recorded because a reviewer should not read the negative half as
   an existence proof.
2. **`LoteExtraivel` is imported, not declared here.** Task 25 says "add `LoteExtraivel`"; the type
   already exists in `customer-memory-extraction.ts` (Slice 5), so the worker imports it together with
   `extrairFatosDoLote`. Re-declaring it would have created a second definition of the same contract.
3. **The gate is read zero times in the worker.** `SOFIA_CUSTOMER_MEMORY_ENABLED` /
   `customerMemoryEnabled` do not appear in `inbound-batch-worker.ts`; the single gate read stays inside
   `extrairFatosDoLote`, which returns `0` when closed. This keeps the "one gate, one read" invariant
   from Slice 5 intact.
4. **`npx eslint` is not usable as evidence on this host.** `npx` resolves a global ESLint 6.4.0 that
   cannot read this repository's flat config and exits 2 with an unparseable body. The repo-local binary
   (`node_modules/.bin/eslint`, 9.39.4) exits 0 on both files, and CI's `Lint` step runs
   `npm run lint`, which was run and exits 0. The slice-5 record's `npx eslint` line is a host artifact
   of the same kind and is corrected by this note.
5. **The first writer attempt returned a derailed report.** Its session received the in-session RDD
   review reminder while it mutated files and answered a review-disposition question instead of
   reporting the work, returning `status: partial` with no file change claimed — even though the two
   files were in fact written. The parent verified the worktree, reviewed the diff, re-derived the RED
   and re-ran the checks rather than trusting the report. **Operational consequence:** while an
   unreviewed accumulated candidate exists, every mutation in any session re-offers that candidate, and
   delegation to writers can be interrupted by it.

### Chain context (chained-pr / work-unit-commits contract)

| Field | Value |
| --- | --- |
| Strategy | Feature Branch Chain (stacked-to-main) |
| Tracker | Issue #165 (documentation); PR chain #166–#173 published before this slice |
| Position | Slice 6 of 10; PR 9 of the published chain |
| Base | `feat/sofia-customer-memory-slice-5` |
| Dependency | PR 8 (Slice 5) — `extrairFatosDoLote` |
| Follow-up | Slice 7 (approved-facts prompt block, tasks 28–31) |
| Changed-line budget | 200 of 400 |
| Verification | Worker suite + payment-proof harness guard, `tsc`, `npm run lint`; CI re-runs all of it |

## Corrections — defects exposed by the published chain (2026-09-19)

Publishing the branch chain ran the repository's `pull_request` workflow for the first time on this
work, and it found **two** defects that the slice-local evidence could not see. CI failed on Slice 4
(`Run hermetic tests`), failing Slice 5 with it:

```
FAIL tests/unit/payment-proof-harness-bootstrap.test.ts > admin_user_dual_deletion.sql imports only
its explicitly allowlisted forward migrations
AssertionError: expected [ …(13) ] to deeply equal [ …(11) ]
```

`payment-proof-harness-bootstrap.test.ts` pins the exact, ordered list of forward migrations each SQL
suite may import. Task 15/16 of Slice 4 added two guarded `\ir` includes to
`supabase/tests/admin_user_dual_deletion.sql` (`20260918010000_fatos_cliente_schema.sql` and
`20260918030000_anonymize_fatos_cliente.sql`) without updating that allowlist. The Slice 4 task text
never named this guard, and neither the focused pgTAP evidence nor the local runs could see it: the
guard is a hermetic Vitest test that only the whole-suite CI job exercises. Fixed on the Slice 4 branch
by commit `cc1c52c` (`test(sofia): allowlist the customer-memory migrations in the dual-deletion
guard`), which adds the two entries in the file's own order; the local RED/GREEN pair is
`expected [ …(13) ] to deeply equal [ …(11) ]` → `Tests 29 passed (29)`.

This is the honest failure mode of a slice-local evidence discipline: a **cross-cutting hermetic guard**
is only enforced when the whole suite runs together. It also corrects the implicit assumption in the
Slice 4 record that its suite green plus the sanctioned run covered the slice — they did not cover the
guard. Slice 1, 2, 3 and the roadmap/hygiene PR passed the same workflow unchanged.

### Slice 5 — the root type-check program

The same workflow then failed the Slice 5 pull request at `Type-check` instead:

```
##[error]tests/unit/sofia-customer-memory-extraction.test.ts(152,34): error TS2493: Tuple type '[]'
of length '0' has no element at index '0'.
```

A spy created as `vi.fn(async () => ...)`, without a parameter signature, has `mock.calls` typed as the
empty tuple `[]`, so destructuring call index 0 is a type error. Fixed on the Slice 5 branch by
`73d734e`, which types the call list at the assertion site; the suite stays green at 46/46.

Why the slice record could not catch it: the type-check command in the task text, and therefore in the
slice evidence, was `npx tsc --noEmit -p apps/web/tsconfig.json`, and **that program excludes `tests/`**.
CI runs the root `npx tsc --noEmit`, which includes every test file. A slice that only type-checks
`apps/web` cannot see a defect in its own test file.

### The lesson both corrections share

The slice-local evidence commands were narrower than the CI job in **two independent ways**: the focused
suite missed a cross-cutting hermetic guard (Slice 4), and the narrowed type-check program missed the
test files the slice had just written (Slice 5). From here, a slice's evidence uses the CI commands
themselves — root `npx tsc --noEmit` and the full hermetic suite — whenever the slice touches `tests/`.

One more host note, because it cost time: on this checkout a stale `tsconfig.tsbuildinfo` (gitignored,
`incremental: true`) **fabricates** an error in a file the slice never touched. Locally the root program
reported `tests/unit/evolution-payment-proof-intake.test.ts(100,18): error TS7023`, which CI does not
report and which disappears with `--incremental false`; the root program is otherwise clean. Verify a
suspicious type error that way before treating it as real.

## Slice 7 — Approved-facts prompt block (tasks 28-31)

### Delivery ledger (this run)

- **Files:** `apps/web/src/lib/sofia/customer-memory.ts` (+64), `apps/web/src/lib/ai/openrouter.ts` (+21/−1),
  NEW `tests/unit/sofia-customer-memory-prompt.test.ts` (582 lines, 20 tests, 108 assertions).
  **668 changed lines** against the ~180 forecast and the 400-line budget → `size:exception` (below).
- **Evidence observed by the parent:** focused suite 20/20; regression 47/47 across
  `sofia-rag-enhancement`, `sofia-customer-memory` and `sofia-customer-memory-extraction`; pipeline
  consumers 17/17; `npx tsc --noEmit --incremental false` clean; `npm run lint` clean.
- **Two independent read-only verifications.** The first one **rejected** this slice and is the reason
  the delivered shape differs from the first implementation; the second re-verified the repair.

### What the slice delivers

`agruparFatosParaPrompt` (design §6.3) as a pure renderer in `customer-memory.ts`: header/footer
verbatim from the design, the fixed `- <tipo>/<chave>: <valor>` grammar, at most 20 fact lines and
1200 characters of joined fact-line content, whole lines only, `null` when nothing usable remains. In
`openrouter.ts`, the single gated `buscar_fatos_para_prompt` fetch (design §7.5) and one template
insertion between the active-orders interpolation and `HISTÓRICO DA CONVERSA:`.

### TDD Cycle Evidence

- **RED:** observed on first creation (`Tests 16 failed | 2 passed (18)`) and re-derived over the
  final bytes with the implementation temporarily reverted (`Tests 19 failed | 1 passed (20)`), then
  again after the repair by restoring the two-line interpolation (`4 failed | 16 passed`).
- **GREEN:** 20/20 focused, 47/47 regression, 17/17 pipeline consumers, `tsc` clean, `lint` clean.
- **TRIANGULATE:** byte-exact regions, cap boundaries, injection attempts, subordination region and
  both failure paths, all through the real pipeline with a mocked RPC.
- **REFACTOR:** single null path in the renderer; source-level assertions pin the one-line insertion.

### First verification rejected the slice — the honest record

The first implementation put the facts interpolation on its own physical template line and claimed
byte-identity for the closed gate. Independent verification measured the opposite: the segment before
`HISTÓRICO DA CONVERSA:` went from 5 newlines to 6, and the assertion that was supposed to prove
identity compared two post-change renders, so it would also have passed with the renderer deleted. It
also found the placement assertion non-falsifiable (a block misplaced anywhere after the article
listing would still pass), a forbidden-string loop over rows its mock never contained, and a
fact-value log assertion on a branch where the value cannot occur. All four were repaired before this
slice was committed, and the second verification confirmed each repair fails on the corresponding
mutation.

### Deviations and known limits

1. **§7.5's snippet contradicts its own byte-identity claim (load-bearing deviation).** The snippet
   shows the facts interpolation on its own template line; that shape adds one newline even when the
   block is empty, contradicting §7.5 and `specs/memoria_cliente/spec.md`'s requirement that the
   closed-gate prompt be identical to the pre-change prompt. The interpolation therefore shares the
   physical line with `${contextoPedidosAtivos}`. The design document is left as approved; this
   record is the deviation trail.
2. **F4 — the RPC `error` field is ignored (not changed here).** `const { data } = await
   supabase.rpc(...)` inside `try`/`catch` is design §7.5 verbatim and matches the neighbouring
   active-orders fetch in the same file. A resolved error result therefore degrades silently to an
   empty block: with the gate enabled and no rows, the prompt is indistinguishable from the gate being
   closed. Fixing it means logging `error` or emitting a metric, i.e. changing §7.5 — a follow-up.
3. **F5 — the footer is one physical line** while §6.3's fenced block wraps it across three. Joining
   those three document lines with single spaces reproduces the constant exactly (verified
   mechanically, not by eye), and the normative spec does not mandate wrapping.
4. **Log scope, disclosed.** The §7.5 catch logs the error object verbatim. No fact `valor` can reach
   it (the RPC request carries only `p_cliente_id` and `p_limite`; the renderer logs nothing), but a
   value-shaped string inside a driver error message is echoed. The rejection-path test therefore
   asserts what is true: no header/footer in any log line, and exactly one driver echo, rather than a
   "no value-shaped bytes ever" claim it cannot make without changing §7.5.
5. **The DB owns the state filter.** The renderer does no `estado`/`observacao` filtering; that rule is
   the RPC predicate and is covered by the pgTAP suite. The unit tests state this boundary instead of
   faking a local proof of it.

### Size exception (parent decision, declared for review)

**668 changed lines**, of which 582 are the new test file — and that file is assertion-dense, not
padded: 20 tests carrying 108 assertions (≈5.4 lines per assertion), whose longest constants are the
proof itself (the documented pre-change byte replay and the §6.3 wording). Compacting it toward the
minified style of the sibling suites in this change would make it harder to review without removing a
single assertion. The size is structural: this is a prompt-injection surface where every guarantee is
a byte-exact region, so each one costs a literal.

### Chain context (chained-pr / work-unit-commits contract)

| Field | Value |
| --- | --- |
| Strategy | Feature Branch Chain — slice 7 of 10; slices 1-6 are already in `main` (`56e3236`) |
| Tracker | Issue #165 |
| Position | 7 of 10 |
| Base | `main` |
| Dependency | Slices 1-6 (`buscar_fatos_para_prompt`, the gate, the RPCs) |
| Follow-up | Slice 8 (operator authorization move and review actions, tasks 32-35) |
| Rollback | Revert this commit; with the gate closed the prompt returns to the pre-change bytes |
| Verification | Focused + regression + pipeline-consumer suites, root `tsc`, `npm run lint`; CI re-runs all of it |

## Slice 8 — Operator authorization move and review actions (tasks 32-35)

### Delivery ledger (this run)

- **Files:** NEW `apps/web/src/lib/auth/operador.ts` (37), NEW `apps/web/src/app/actions/fatos-cliente.ts` (96), `apps/web/src/app/actions/atendimento.ts` (+1/−37), NEW `tests/unit/sofia-customer-memory-actions.test.ts` (325). **496 changed lines** (production 171) → `size:exception` (below).
- **Evidence observed by the parent:** focused 29/29; 23/23 across the seven suites that import `@/app/actions/atendimento`; 139/139 for the memory and Sofia suites; root `tsc` clean; repository ESLint clean.
- **Independent read-only verification** confirmed the move is byte-identical, the wire contract is pinned, and the refusal-before-RPC cases cannot pass a pre-authorization call. It also found four small evidence defects (a tautological mapping assertion, a missing leak assertion in the `revisar` twin, a multi-line-return hole in the "no raw client in a return" check, and a dead call recorder in the transport cases) plus one comment nit; all five were repaired in the same commit before publication.

### What the slice delivers

The operator gate (`FUNCOES_OPERADOR_AUTORIZADAS`, `AuthorizedOperatorCheck`, `verificarOperadorAutorizado`) moves verbatim into `lib/auth/operador.ts` so a `'use server'` module no longer exports the helper, and `atendimento.ts` imports it with its three call sites untouched. A new `'use server'` module exposes `listarFatosCliente(clienteId)` and `revisarFatoCliente(fatoId, decisao, valor = null)`: operator check first, then the RPC, returning the repository's `{ success, data | error }` shape.

### TDD Cycle Evidence

- **RED:** module absent (`Failed to resolve import "@/app/actions/fatos-cliente"`), then against an ungated stub that relayed `error.message` (`Tests 18 failed | 11 passed (29)`).
- **GREEN:** 29/29 focused; 23/23 and 139/139 in the regression sets; `tsc` and the repository ESLint clean.
- **TRIANGULATE:** five mutations, each killed by its own cases (role list, limit constant, error relay, table access, non-serializable export).
- **REFACTOR:** source-level assertions over real module text for the table-access, export-shape and token boundaries.

### Deviations and known limits

1. **Error granularity is coarse.** `tokenDeErroDaRpc` maps `42501` to `ACESSO_NEGADO_PERMISSAO_INSUFICIENTE` and collapses everything else (including `P0002` and `22023`) to `ERRO_INTERNO`, so "fact not found" and "invalid decision" reach the operator as an internal fault. Task 35 requires only that no token beyond the session vocabulary leaks, and this is stricter than `atualizarClienteCrm` (which interpolates raw messages) but coarser than `pedidos.ts` (which maps domain tokens). Finer tokens are a product call for the panel slice, not a defect of this one.
2. **`p_estados: null` is deliberate.** The RPC's own default is `null` (all four states, `20260918020000_fatos_cliente_rpcs.sql`), and the task lists `p_estados` as an argument, so the action passes it explicitly rather than omitting it.
3. **The action suite asserts the client boundary, not the database.** That the database really raises `42501`/`22023`/`P0002`, enforces the operator gate and returns only approved non-`observacao` facts is proven by the Slice 3 pgTAP suite.
4. **No UI consumes these actions yet**; the panel arrives in Slice 9.

### Size exception (parent decision, declared for review)

**496 changed lines**, of which 325 are the new test file. Production is 171 lines, inside the ~200 forecast; the overage is the mandated evidence — four unauthorized scenarios × two actions, three SQLSTATEs × two actions, transport cases, source-level boundary checks and the verbatim-move control. Trimming it to reach the number would delete evidence, so the exception is declared instead of the tests being compressed.
### Chain context (chained-pr / work-unit-commits contract)

| Field | Value |
| --- | --- |
| Strategy | Feature Branch Chain — slice 8 of 10; slices 1-7 are in `main` |
| Tracker | Issue #165 |
| Position | 8 of 10 |
| Base | `main` |
| Dependency | Slices 1-6 (the operator RPCs this surface calls) |
| Follow-up | Slice 9 (operator facts panel, tasks 36-39) |
| Rollback | Revert this commit; no UI consumes the actions yet |
| Verification | Focused + seven regression suites + memory/Sofia suites, root `tsc`, repository ESLint; CI re-runs all of it |

## Slice 9 — Operator facts panel and `fatos` tab (tasks 36-39)

### Delivery ledger (this run)

- **Files:** NEW `apps/web/src/components/operator/OperatorClientFactsPanel.tsx` (314), `apps/web/src/components/operator/ClientCrmPanel.tsx` (+34/−5), NEW `tests/unit/operator-client-facts-panel.test.tsx` (445), `tests/components/operator/ClientCrmPanel.test.tsx` (+10/−2). **810 changed lines** → `size:exception` (below).
- **Evidence observed by the parent:** focused 18/18, focused pair 21/21; eight-suite operator set 38/38; root `tsc` clean; repository ESLint clean.
- **Independent read-only verification** confirmed the behaviour and the six mutation kills, and found five repairs that were made before publication (the correction `.trim()` and the empty-value guard were unfalsifiable; a four-way disjunction stood in for the state label; the header count was unasserted; the isolation guard would miss a relative or barrel Supabase import) plus one documentation error of the parent's, corrected below.

### What the slice delivers

A client panel that lists every fact state (`pendente`, `aprovado`, `rejeitado`, `substituido`) with `tipo`, `chave`, `valor`, `origem`, `confianca` (rendered only for `origem = 'ia'`) and the originating conversation, with approve/reject and an inline correction form wired to the slice-8 actions, plus loading, empty and refusal states. A fourth `fatos` tab joins the operator's `carrinho`/`pedidos`/`crm` tablist with the same ref, `role`, `aria-selected` and roving `tabIndex` pattern.

### TDD Cycle Evidence

- **RED:** unresolved component import, `Test Files 1 failed (1)`, `Tests no tests`.
- **GREEN:** 18/18 focused, 21/21 with the keyboard test, 38/38 across the operator set, `tsc` and ESLint clean.
- **TRIANGULATE:** six mutations with one killed case each, plus the negative paths (refusal without rows, a failed result that still carries `data` rendering nothing, a failed review keeping the list without refetching, and the lazy mount that does not call the facts action while the other tabs are open).
- **REFACTOR:** source-level isolation guard, no duplicated formatting helper, first three tabs byte-identical apart from the import and the new neighbour.

### Deviations and known limits

1. **The operator surface is NOT behind `SOFIA_CUSTOMER_MEMORY_ENABLED`** (this corrects an earlier claim of the parent's). The flag gates extraction and prompt injection only, in `customer-memory-extraction.ts` and `ai/openrouter.ts`. Listing and reviewing facts is authorized by `verificarOperadorAutorizado()` plus the RPCs' own role check, so an authorized operator can list and review facts with the flag at `false`, when the table can only hold rows written by an operator, an import or a manual insert. Tasks 36-39 do not ask for a memory-flag gate on the operator surface; if the product wants one, it is a separate decision.
2. **`observacao` rows are visible to the operator by design**, and the panel header counts them. Verified independently that there is no leak path: `buscar_fatos_para_prompt` (prompt), `meus_fatos_cliente` (customer read) and the customer write paths all exclude or refuse `tipo = 'observacao'`, and `revisar_fato_cliente` cannot change a fact's `tipo`.
3. **Residual design-level risk, not this slice's**: the only barrier keeping an internal note out of the prompt is its `tipo` label — a note typed into a normal `tipo` and approved by an operator is injected as labeled data. This is the residual risk already accepted in design §6.3.
4. **The isolation guard is textual.** Regexes over two files; a barrel or relative-path Supabase import would still be caught after this revision (any `supabase` occurrence is forbidden), but a runtime-built table name would not.
5. **No database exercise.** The panel is never run against the real RPC; the DB guarantees remain the pgTAP suite's.

### Size exception (parent decision, declared for review)

**810 changed lines**, of which 457 are tests. The panel and its suite carry the whole operator review surface — four states, five fields, three review actions, three non-happy states, the tablist integration and a source-level isolation guard — and every guarantee is a falsifiable case, so the size is structural rather than padded.

### Chain context (chained-pr / work-unit-commits contract)

| Field | Value |
| --- | --- |
| Strategy | Feature Branch Chain — slice 9 of 10; slices 1-8 are in `main` |
| Tracker | Issue #165 |
| Position | 9 of 10 |
| Base | `main` |
| Dependency | Slice 8 (the actions the panel calls) |
| Follow-up | Slice 10 (client facts section, tasks 40-43) |
| Rollback | Revert this commit; the panel and its tab disappear, no other surface depends on them |
| Verification | Focused pair + eight-suite operator set, root `tsc`, repository ESLint; CI re-runs all of it |
