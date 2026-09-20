# Proposal: Sofia Customer Memory (`fatos_cliente`)

Sofia gains a per-customer, typed, auditable fact store so she remembers a customer across
conversations and channels. The first slice ships the table, its RPC surface, incremental
extraction after each turn, prompt injection of approved facts only, an operator review surface,
a client-facing access plus rectification surface, and the LGPD deletion fix that keeps the new
table out of the anonymization blind spot. Everything is behind a default-off feature gate.

## Intent

Today Sofia has no memory of a customer beyond the last 10 messages of the current conversation
plus the global `base_conhecimento` RAG store, which has no per-customer dimension. Nothing
persists a per-customer fact, so a returning customer re-explains the same address, preference, or
restriction on every conversation.

- **Product goal:** Sofia remembers the customer across conversations.
- **Parent:** first slice of roadmap child 6 (`sofia-intelligence`) from
  `openspec/changes/sofia-channel-hardening-roadmap/proposal.md`.
- **Approved design input:** topic key `crm-sofia/customer-facts-table-design` (Engram observation
  68), settled and not re-litigated here. This proposal stays consistent with it; it only sharpens
  scope.
- **Product decisions already resolved upstream** (orchestrator-owned; this proposal does not
  re-interview the user):

| Decision | Resolution |
| --- | --- |
| Extraction timing | Incremental, after each turn. There is no conversation-close event in this codebase: `status_conversa` declares `'fechada'` but no production writer sets it. |
| Approval model | High-confidence AI facts auto-approve; the rest wait for review. Bounded by the invariant below. |
| Customer visibility | The customer sees and corrects their own facts from the portal, covering LGPD access and rectification. `tipo = 'observacao'` stays internal. |
| Slice width | Typed facts only. No rolling summary table. |

## Scope

### In Scope

1. **Schema:** `public.fatos_cliente`, one row per fact, pt-BR naming per the CRM-domain convention
   (`clientes`, `conversas`, `pedidos`).
2. **RPC surface:** the seven settled RPCs, with RPC-only access and no direct table grants.
3. **Extraction:** incremental, one economy-tier model call per turn, running at the batch worker's
   post-completion boundary; no retry on failure.
4. **Prompt injection:** approved facts only, capped at roughly 20 facts / 1200 characters, placed
   in `apps/web/src/lib/ai/openrouter.ts` between `contextoPedidosAtivos` (L362) and
   `HISTÓRICO DA CONVERSA` (L364).
5. **Operator review surface:** list every state, approve, reject, or correct, in the operator CRM
   panel pattern (`apps/web/src/app/actions/clientes.ts:atualizarClienteCrm` +
   `components/operator/ClientCrmPanel.tsx`, gated by `verificarOperadorAutorizado()`).
6. **Client portal surface:** view own approved facts (excluding `observacao`), correct one, or
   refuse one, in `/cliente/perfil`.
7. **LGPD correction (see below):** extend `anonymizar_usuario_admin` so anonymization deletes the
   customer's `fatos_cliente` rows.
8. **Feature gate:** `SOFIA_CUSTOMER_MEMORY_ENABLED`, strict `"true"`, closed by default, matching
   the `inbound-batch-gates.ts` pattern. The same gate controls extraction and prompt injection.
9. **Verification:** a SQL harness test for constraints, RPC authorization, owner isolation, and
   anonymization deletion, plus vitest unit tests for the prompt block and the worker hook.

### Out of Scope

- Rolling summary table, embeddings, pgvector, or semantic recall.
- Any channel-side capability. WhatsApp typing and buttons are protocol-blocked on
  Baileys/Evolution (roadmap finding 4), so this change promises no WhatsApp or Telegram surface.
- The `ChannelProvider` contract (child 5). This slice is channel-agnostic because it hooks the
  batch pipeline and prompt assembly shared by every channel; it therefore has **no dependency on
  child 5**.
- Approved-feedback loops and Sofia metrics (the remaining `sofia-intelligence` slices).
- Extraction on conversation close; not implementable without inventing the missing event.
- Fixing the pre-existing `clientes.notas` retention gap under anonymization. It is flagged in
  **Open Decisions** as a follow-up candidate, not silently absorbed here.
- Fact-volume dashboards, multi-agent personas, and per-fact prompt ranking.
- Direct table access for `authenticated`; the surface is RPC-only by design.

## Capabilities

### New Capabilities

- **`memoria_cliente`** (recommended name): per-customer typed facts with provenance, bounded
  auto-approval, operator review, client rectification, and approved-only prompt consumption.

The roadmap declares child 6 as new capability `sofia-intelligence`, whose stated scope also covers
approved feedback, summaries, and metrics — none of which are in this slice. Naming this slice
`memoria_cliente` keeps the capability honest and leaves `sofia-intelligence` as the umbrella for
the later slices. This is a scope-sharpening choice, not a contradiction; see **Open Decisions** for
the alternative.

### Modified Capabilities

| Capability | Change |
| --- | --- |
| `rag_conhecimento` | The prompt gains a second, per-customer knowledge source with different authority: approved facts are advisory customer context, never global policy. Pending facts and internal notes never reach the model. |
| `crm_vendas` | The operator client panel gains a facts review surface over the existing CRM metadata authority. |
| `client-navigation` | `/cliente/perfil` gains the client's own facts section. |
| `dashboard_admin` | The LGPD anonymization authority deletes the customer's facts, not only their profile fields. |

## Approach

The design is settled; the proposal only fixes its boundaries. The summary below exists so
reviewers can verify intent without reopening Engram.

### Data shape

| Column | Shape |
| --- | --- |
| `id` | uuid primary key |
| `cliente_id` | FK `public.clientes`, `on delete cascade` |
| `tipo` | `endereco \| preferencia \| restricao_alimentar \| formato_pedido \| observacao` |
| `chave` | text, regex `^[a-z0-9_]{1,64}$` |
| `valor` | text, length 1..500 |
| `origem` | `cliente \| operador \| ia \| importado` |
| `origem_conversa_id` | provenance for inferred facts |
| `confianca` | `numeric(3,2)` |
| `estado` | `pendente \| aprovado \| rejeitado \| substituido` |
| `revisado_por`, `revisado_em` | review record |
| `substitui_id` | self reference for supersession |
| `criado_em`, `atualizado_em` | timestamps |

Exact FK targets and nullability are settled design detail; the spec and design phases restate them
verbatim rather than re-deciding.

### Invariants

| Invariant | Definition | Why it matters |
| --- | --- | --- |
| `ck_fatos_cliente_confianca` | `origem = 'ia' or confianca is null` | Confidence exists only for inferred facts; typed human facts carry no fake certainty. |
| `ck_fatos_cliente_aprovacao` | approved requires a trusted origin **or** `revisado_por is not null` **or** the bounded auto-approval `origem = 'ia' and tipo <> 'restricao_alimentar' and confianca >= 0.85` | The central safety invariant. The `0.85` threshold lives inside the constraint, deliberately, so lowering it requires a migration. |
| `uq_fatos_cliente_vigente` | partial unique on `(cliente_id, tipo, chave) where estado in ('pendente','aprovado')` | One vigente fact per key; everything else is history reachable through `substitui_id`. |
| Prompt admission | Only `estado = 'aprovado'` facts may reach the prompt | A pending inference must never be treated as knowledge. |
| Auto-approval audit | `origem = 'ia' and revisado_por is null and estado = 'aprovado'` is its signature | Auditable without an extra column. |

**Safety exception.** `restricao_alimentar` is never auto-approved, even at high confidence. A
hallucinated allergy fact injected into every future prompt can cause physical harm and is
irreversible at the moment of the answer. This is a deliberate exception accepted by the user and
must not be relaxed by configuration.

### RPC surface

| RPC | Authority | Behavior |
| --- | --- | --- |
| `registrar_fato_cliente` | `service_role` | Writes a fact, resolves supersession through `substitui_id`. |
| `listar_fatos_cliente` | operator gate via `tem_funcoes` | All states for review. |
| `revisar_fato_cliente` | operator | Approve, reject, or correct. |
| `meus_fatos_cliente` | owner | Approved only, excluding `observacao`. |
| `corrigir_meu_fato_cliente` | owner | Sets `origem = 'cliente'`; a customer's own statement is the strongest provenance. |
| `recusar_meu_fato_cliente` | owner | Marks the fact rejected. |
| `buscar_fatos_para_prompt` | `service_role` | Approved only; the single read path used by prompt assembly. |

RPCs follow the repository's current style: `security definer set search_path=''`, `revoke all` then
explicit `grant execute`, `SOFIA_*` messages, and the existing errcode vocabulary
(`22023` / `42501` / `P0002`). Owner RPCs resolve the customer through
`clientes.usuario_id = auth.uid()`. The table itself keeps `revoke all` from
`public, anon, authenticated, service_role`, so facts are reachable only through these functions.

### Extraction

- Runs for each processed turn, inside `apps/web/src/lib/sofia/inbound-batch-worker.ts`, at the
  post-completion boundary, after `complete_sofia_inbound_batch` /
  `complete_sofia_inbound_batch_paced` reports success.
- Because the batch is claimed and completed exactly once, extraction runs at most once per batch
  with **no extraction ledger**.
- The honesty check: the batch lease is already released at that point, so this is not a second
  fence. A crash between completion and extraction loses that batch's facts. That is accepted, and
  consistent with this repository's stated preference for no-duplicate over guaranteed-delivery.
  Failure is logged and **not retried**. The design phase fixes the exact hook for both the runtime
  and non-runtime completion paths.
- Economy tier, JSON output, small `max_tokens`, gated by `SOFIA_CUSTOMER_MEMORY_ENABLED`.

### Injection and cost

- Approved facts are rendered as a clearly labeled data block between `contextoPedidosAtivos` and
  `HISTÓRICO DA CONVERSA`, capped at roughly 20 facts / 1200 characters.
- Cost is one extra model call per turn, mitigated because Sofia already batches several inbound
  messages into one turn: the cost is per batch, not per message.

## LGPD and Deletion

This change creates concrete LGPD debt if it ships without fixing the anonymization path.

| Path | Current behavior | Required behavior for facts |
| --- | --- | --- |
| `anonymizar_usuario_admin` (`supabase/migrations/20260826222000_dual_deletion_runtime_fixes.sql`) | Rewrites `nome`, `telefone`, and clears `usuario_id`, `email`, `telegram_chat_id` on `clientes`; **deletes no rows** | MUST delete the target customer's `fatos_cliente` rows. Otherwise anonymization leaves facts such as "mora en Rua X, 123" alive after the customer was anonymized. |
| Total purge (`iniciar_purga_total_usuario_admin` and downstream) | Removes the customer row, so `on delete cascade` already covers facts | No change; the cascade is the reason `cliente_id` carries `on delete cascade`. |

Order matters: the extension must capture the affected `cliente_id` values and delete the facts
**before** or atomically with nulling `clientes.usuario_id`, since after nulling the link from user
to client is gone. Reverting this extension must not be done alone; see **Rollback Plan**.

This extension is in scope, with its own SQL harness test asserting that facts are gone after
anonymization while unrelated customers' facts survive.

## Affected Areas

| Area | Impact | Description |
| --- | --- | --- |
| `supabase/migrations/*` | New | `fatos_cliente` table, constraints, partial unique index, RPCs, grants, audit columns. |
| `supabase/migrations/*` | Modified | Extend `anonymizar_usuario_admin` to delete the customer's facts. |
| `supabase/tests/*` | New | Constraints, auto-approval bounds, RPC authorization, owner isolation, anonymization deletion. |
| `apps/web/src/lib/sofia/inbound-batch-worker.ts` | Modified | Post-completion extraction hook, gated, non-retrying. |
| `apps/web/src/lib/sofia/inbound-batch-gates.ts` | Modified | Add the strict `SOFIA_CUSTOMER_MEMORY_ENABLED` gate. |
| `apps/web/src/lib/ai/openrouter.ts` | Modified | Approved-facts block between `contextoPedidosAtivos` and `HISTÓRICO DA CONVERSA`. |
| `apps/web/src/app/actions/clientes.ts`, `components/operator/ClientCrmPanel.tsx` | Modified | Operator facts review surface. |
| `apps/web/src/app/cliente/perfil/**` | Modified | Client-visible facts with correct and refuse actions. |
| `openspec/specs/*` | New/Modified | Delta specs for `memoria_cliente` and the modified capabilities above. |

## Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Hallucinated fact becomes durable "knowledge" | Med | Approved-only prompt admission; auto-approval bounded by a fixed threshold inside the invariant; `restricao_alimentar` never auto-approves; customer rectification and operator review provide two correction paths. |
| Prompt injection through an auto-approved fact (customer text reaching the system prompt as content) | Med | Extraction output is structured and validated server-side (`tipo` enum, `chave` regex, `valor` length); the block is rendered as labeled data, not instructions. Residual risk is accepted and must be documented in the spec; any stricter `valor` normalization is design-owned. |
| Auto-approval weakens the human gate | Med | Threshold cannot be lowered without a migration; auto-approvals are derivable by their signature; sensitive type excluded; every fact is rectifiable. |
| LGPD exposure after anonymization | High if unfixed | The in-scope extension plus a dedicated harness test; the purge path already cascades. |
| Cross-customer leakage | Low | RPC-only access, owner resolution through `clientes.usuario_id = auth.uid()`, `service_role`-only writer, direct table grants revoked; harness test asserts isolation. |
| Extraction cost or latency regression on the turn | Low | Economy tier, small output cap, one call per batch, no retry, gate closed by default. |
| Duplicate or contradictory facts accumulate | Med | Partial unique vigente index plus supersession through `substitui_id`; facts are advisory context and never authoritative policy. |
| Scope grows past one reviewable PR | High | Work-unit slicing below plus an `ask-on-risk` delivery decision at the tasks/apply phase. |

## Rollback Plan

| Layer | Rollback | Notes |
| --- | --- | --- |
| Runtime behavior | Set `SOFIA_CUSTOMER_MEMORY_ENABLED` to anything other than `"true"` | Stops extraction and prompt injection immediately. Facts become inert: no reader remains. No migration required. |
| Prompt block | Revert the `openrouter.ts` block | Independent of the table and RPCs. |
| UI surfaces | Revert the operator panel and `/cliente/perfil` section | Independent of the data layer. |
| RPCs and table | Additive; leave in place while the gate is off, or drop later | Removing them removes no other feature. |
| LGPD extension | Revert `anonymizar_usuario_admin` and the `fatos_cliente` table **in the same rollback** | Reverting the deletion logic while the table survives would silently re-create the anonymization leak. If the table stays, the deletion logic stays. |
| Stored facts | Decide explicitly at rollback time: purge, or retain under the unchanged deletion authority | Retaining is only safe while the deletion authority remains in place. |

## Dependencies

- Supabase migration tooling, `public.tem_funcoes`, `public.tipo_funcao`, `public.clientes`,
  `public.conversas`, `public.logs_auditoria`.
- Batch worker completion boundary and the `inbound-batch-gates.ts` strict-`"true"` gate pattern.
- Prompt assembly in `apps/web/src/lib/ai/openrouter.ts` and the existing OpenRouter tier config for
  the economy model.
- Operator authorization gate (`verificarOperadorAutorizado()`) and the client portal layout.
- Vitest for unit tests and the `supabase/tests` SQL harness for constraint and RPC verification.
- Roadmap child 6 (`sofia-intelligence`) as parent. **No dependency on child 5** (`ChannelProvider`),
  which does not exist yet.

## Delivery and Review Shape

Candidate work units, to be confirmed by `sdd-tasks`:

1. Schema, constraints, index, and SQL harness.
2. RPC surface, grants, and authorization harness.
3. Extraction hook and feature gate.
4. Prompt injection block.
5. Operator review surface.
6. Client portal access, correct, and refuse.
7. LGPD anonymization extension and its test.

This forecast clearly exceeds the 400-line review budget, so the delivery decision (single PR versus
chained slices) is a risk that must be raised with the user at the tasks/apply phase under
`ask-on-risk`. No chain strategy is chosen in this proposal, and `size:exception` is never inferred.

## Success Criteria

- [ ] A returning customer's approved fact is present in the assembled prompt, and the block sits
      between `contextoPedidosAtivos` and `HISTÓRICO DA CONVERSA`.
- [ ] Pending and rejected facts never reach the prompt; `observacao` never reaches the client view.
- [ ] A high-confidence `ia` fact for a non-sensitive type auto-approves, while a high-confidence
      `restricao_alimentar` fact stays `pendente` and cannot be inserted as approved.
- [ ] Confidence cannot be set for non-`ia` origins, and lowering the auto-approval threshold
      requires a migration.
- [ ] Anonymization deletes the anonymized customer's facts and leaves other customers' facts
      intact; total purge still cascades.
- [ ] A customer can read, correct, and refuse their own approved facts, with corrections recorded
      as `origem = 'cliente'`.
- [ ] A customer or another client cannot read facts through any direct table access.
- [ ] With the gate closed, no extraction model call happens and no facts block appears in the
      prompt.
- [ ] Repeated extraction over the same turn produces no second vigente fact for the same
      `(cliente_id, tipo, chave)`.

## Open Decisions

1. **Capability name.** Recommended: new capability `memoria_cliente`, leaving the roadmap's
   `sofia-intelligence` umbrella for the later feedback, summary, and metrics slices. Alternative:
   declare `sofia-intelligence` now and scope its first delta to memory. Either is compatible with
   the settled design; the spec phase needs one answer.
2. **`clientes.notas` LGPD gap.** Operator free-text notes keep the same anonymization blind spot as
   facts and predate this change. Recommended: leave out of scope here and track as a separate
   follow-up, so this change stays reviewable. This proposal does not claim to fix it.

No proposal question round is offered: the four product decisions above were resolved upstream by
the orchestrator, and this phase must not re-interview the user about them.
