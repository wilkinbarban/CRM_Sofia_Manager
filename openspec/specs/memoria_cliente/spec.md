# memoria_cliente Specification

## Purpose

Sofia remembers a returning customer across conversations and channels through a per-customer,
typed, auditable fact store with provenance, bounded auto-approval, operator review, client
rectification, and approved-only consumption by the Sofia prompt.

`memoria_cliente` is the first slice of roadmap child 6 (`sofia-intelligence`) declared in
`openspec/changes/sofia-channel-hardening-roadmap/proposal.md`. That child also covers rolling
summaries, approved feedback, and Sofia metrics; those later slices are not specified here. The
capability keeps a pt-BR name to match this repository's CRM-domain capabilities (`crm_vendas`,
`estoque`, `perfil_operador`, `bandeja_operador`) and leaves `sofia-intelligence` as the umbrella
for the remaining slices.

**Scope boundaries (recorded non-goals).**

- No rolling summary table, embeddings, pgvector, or semantic recall.
- No channel-specific surface. The capability hooks the shared batch pipeline and the shared prompt
  assembly, so it is channel-agnostic and depends on no `ChannelProvider` work.
- The pre-existing retention gap for operator free-text `clientes.notas` under anonymization is
  **not** fixed here. It predates this change, is recorded as a follow-up candidate for a later
  slice, and no requirement below claims to fix it.

## Requirements

### Requirement: Per-customer typed fact store

The system MUST persist customer facts in one table `public.fatos_cliente`, one row per fact, with
pt-BR identifiers per the repository's CRM-domain convention. The table MUST declare at least `id`
(uuid primary key), `cliente_id` (foreign key to `public.clientes` with `on delete cascade`),
`tipo`, `chave`, `valor`, `origem`, `origem_conversa_id`, `confianca`, `estado`, `revisado_por`,
`revisado_em`, `substitui_id` (self reference to `fatos_cliente`), `criado_em`, and `atualizado_em`.

Only these `tipo` values MUST be accepted: `endereco`, `preferencia`, `restricao_alimentar`,
`formato_pedido`, `observacao`. Only these `origem` values MUST be accepted: `cliente`, `operador`,
`ia`, `importado`. Only these `estado` values MUST be accepted: `pendente`, `aprovado`,
`rejeitado`, `substituido`. `chave` MUST match `^[a-z0-9_]{1,64}$`. `valor` MUST be between 1 and
500 characters.

#### Scenario: One row per fact

- GIVEN a customer with approved facts
- WHEN that customer's facts are read
- THEN every returned fact MUST correspond to exactly one row of `public.fatos_cliente`

#### Scenario: Domain values are constrained

- GIVEN a write to `public.fatos_cliente`
- WHEN `tipo`, `origem`, or `estado` falls outside its permitted set, `chave` violates the regex, or
  `valor` is empty or longer than 500 characters
- THEN the write MUST be rejected and no row MUST be persisted

#### Scenario: Customer deletion cascades

- GIVEN a customer with facts
- WHEN the customer row is deleted
- THEN every fact of that customer MUST be removed by the `on delete cascade` foreign key

### Requirement: Confidence bounded to inferred facts

`confianca` MUST exist only for `origem = 'ia'`. A fact with any other origin MUST NOT carry a
confidence value. When present, `confianca` MUST be a numeric value between 0 and 1 inclusive.

#### Scenario: Human-provided fact carries no confidence

- GIVEN a write with `origem = 'operador'` or `origem = 'cliente'`
- WHEN the write attempts to set a non-null `confianca`
- THEN the write MUST be rejected

#### Scenario: Inferred fact may carry confidence

- GIVEN a write with `origem = 'ia'`
- WHEN the write sets `confianca = 0.90`
- THEN the write MUST be accepted

### Requirement: Bounded auto-approval invariant

A fact MUST NOT be stored with `estado = 'aprovado'` unless at least one of these holds:

1. its `origem` is `cliente` or `operador`, i.e. a fact a human stated and can be held to; or
2. `revisado_por` records a human reviewer; or
3. the bounded auto-approval holds — `origem = 'ia'` AND `tipo <> 'restricao_alimentar'` AND
   `confianca >= 0.85`.

`importado` is valid as an `origem` value but is deliberately outside that trusted set. The
user-approved design (Engram observation 68) never lists `importado` as trusted; it is the only
provenance whose trust claim is neither bounded by `confianca` like `ia` nor attached to a human like
`cliente` and `operador`; and auto-approving it would create a second, invisible auto-approval class
(`origem = 'importado' AND estado = 'aprovado' AND revisado_por IS NULL`) that the audit predicate in
*Auditable auto-approval without a dedicated column* does not select. An `importado` fact therefore
reaches `estado = 'aprovado'` only through a recorded reviewer.

The `0.85` threshold MUST be enforced inside the database constraint that carries this invariant.
The effective threshold MUST NOT be changeable through an environment variable, an application
setting, or an administrative interface; lowering it MUST require a migration.

#### Scenario: High-confidence inferred fact auto-approves

- GIVEN an inferred fact with `origem = 'ia'`, `tipo = 'preferencia'`, and `confianca = 0.85`
- WHEN it is recorded
- THEN it MUST be stored as `estado = 'aprovado'` without a reviewer
- AND the auto-approval MUST be derivable from `origem = 'ia' AND revisado_por IS NULL AND estado = 'aprovado'`

#### Scenario: Below-threshold inference stays pending

- GIVEN an inferred fact with `origem = 'ia'`, `tipo = 'preferencia'`, and `confianca = 0.84`
- WHEN the write attempts to store it as `estado = 'aprovado'`
- THEN the write MUST be rejected
- AND the same fact MUST be accepted as `estado = 'pendente'`

#### Scenario: The database, not the caller, enforces the bound

- GIVEN a caller that performs no threshold check of its own
- WHEN it writes `origem = 'ia'`, `tipo = 'preferencia'`, `confianca = 0.50`, and `estado = 'aprovado'`
- THEN the database MUST reject the write

### Requirement: Permanent safety exclusion for `restricao_alimentar`

A `restricao_alimentar` fact MUST NOT be auto-approved at any confidence value. It MUST reach
`estado = 'aprovado'` only through a trusted non-inferred origin or a recorded human reviewer. No
configuration, gate, or runtime path MUST relax this exclusion.

#### Scenario: Maximum-confidence allergy inference stays pending

- GIVEN an inferred fact with `tipo = 'restricao_alimentar'` and `confianca = 1.00`
- WHEN it is recorded
- THEN it MUST be stored as `estado = 'pendente'`
- AND it MUST NOT be returned by the approved-facts prompt surface

#### Scenario: A reviewer is the only path from inference to approval

- GIVEN a pending `restricao_alimentar` fact with `origem = 'ia'`
- WHEN an operator approves it
- THEN it MUST become `estado = 'aprovado'` with `revisado_por` and `revisado_em` recorded

### Requirement: Single live fact per key with retained history

At most one live fact MUST exist for each `(cliente_id, tipo, chave)` tuple, where live means
`estado` in (`pendente`, `aprovado`). The system MUST enforce this through a partial unique index
over that tuple. When a new fact supersedes a live fact for the same key, the superseded row MUST
transition to `estado = 'substituido'` and link its successor through `substitui_id`. Superseded and
rejected rows MUST be retained as history and MUST NOT be deleted by the supersession path.

A refusal MUST also survive re-inference. When the incoming candidate is `origem = 'ia'`, no live
fact exists for the tuple, and a `rejeitado` row exists for the same `(cliente_id, tipo, chave)` with
the same normalized `valor`, the system MUST store the candidate as `estado = 'pendente'` regardless
of its confidence. The refused row MUST remain `estado = 'rejeitado'` and MUST NOT be superseded.

#### Scenario: Duplicate live fact is rejected

- GIVEN a live fact for a `(cliente_id, tipo, chave)` tuple
- WHEN a second fact for the same tuple is written as `pendente` or `aprovado` without superseding
  the first
- THEN the write MUST be rejected with a uniqueness error
- AND only the original live row MUST remain

#### Scenario: Supersession preserves history

- GIVEN an approved fact for a key
- WHEN a successor fact for the same key is recorded
- THEN exactly one row for that tuple MUST remain live
- AND the previous row MUST be `estado = 'substituido'`, reachable from the successor through
  `substitui_id`

#### Scenario: Rejected facts remain as history

- GIVEN a live fact
- WHEN an operator rejects it
- THEN the row MUST remain stored with `estado = 'rejeitado'`
- AND the key MUST be available for a new live fact

#### Scenario: Refusal is not defeated by re-inference

- GIVEN a fact for a `(cliente_id, tipo, chave)` tuple that was refused and remains
  `estado = 'rejeitado'`
- WHEN extraction re-infers the identical normalized `valor` for that key with `origem = 'ia'` and a
  confidence at or above the auto-approval threshold
- THEN the new fact MUST be stored as `estado = 'pendente'`
- AND it MUST NOT be stored as `estado = 'aprovado'`
- AND the refused row MUST remain `estado = 'rejeitado'` and MUST NOT be superseded

### Requirement: Auditable auto-approval without a dedicated column

Auto-approval MUST be derivable from the stored columns by the predicate
`origem = 'ia' AND revisado_por IS NULL AND estado = 'aprovado'`. An audit query using that
predicate MUST select exactly the auto-approved facts and MUST exclude inferred facts approved by a
human reviewer. The system MUST NOT depend on a separate auto-approval flag column to make that
distinction.

#### Scenario: Audit predicate selects only auto-approvals

- GIVEN one auto-approved inferred fact and one inferred fact approved by an operator with
  `revisado_por` recorded
- WHEN the predicate `origem = 'ia' AND revisado_por IS NULL AND estado = 'aprovado'` is evaluated
- THEN it MUST return the auto-approved fact
- AND it MUST NOT return the operator-approved fact

### Requirement: RPC-only access with explicit grants

`public.fatos_cliente` MUST NOT be reachable through direct table access by any browser-facing
role. The table MUST revoke all privileges from `public`, `anon`, `authenticated`, and
`service_role`, so that every read and write goes through a function. Each function MUST be
`security definer`, MUST set an empty `search_path`, MUST revoke all default execute privileges
first, and MUST then grant execute explicitly only to the roles that need it.

The system MUST expose exactly these functions as its access surface:

| Function | Authority |
| --- | --- |
| `registrar_fato_cliente` | backend (`service_role`) |
| `listar_fatos_cliente` | operator gate through `public.tem_funcoes` |
| `revisar_fato_cliente` | operator gate through `public.tem_funcoes` |
| `meus_fatos_cliente` | owner |
| `corrigir_meu_fato_cliente` | owner |
| `recusar_meu_fato_cliente` | owner |
| `buscar_fatos_para_prompt` | backend (`service_role`) |

Function failures MUST use the repository's error vocabulary: `22023` for invalid input, `42501`
for an unauthorized caller, `23505` for an existing live fact for the key, and `P0002` when the
referenced fact or profile does not exist.

#### Scenario: Direct table access is denied

- GIVEN an authenticated customer session
- WHEN it queries `public.fatos_cliente` directly
- THEN the query MUST be denied and no fact MUST be disclosed

#### Scenario: The backend also uses the function surface

- GIVEN a backend call holding the service role
- WHEN it attempts to read or write facts through direct table access
- THEN it MUST be denied and MUST use the declared function instead

#### Scenario: Error vocabulary is respected

- GIVEN a caller that omits a required parameter, is unauthorized, targets a missing fact, or races
  a live fact for the key
- WHEN the failure is raised
- THEN the error code MUST be `22023`, `42501`, `P0002`, or `23505` respectively

### Requirement: Operator review authority

Operators holding `admin`, `supervisor`, or `vendedor` MUST be able to list a customer's facts in
all states and to approve, reject, or correct a fact. Listing and reviewing MUST be gated by
`public.tem_funcoes`. A review decision MUST record the reviewing operator and the review time.
Correcting a value MUST keep the stored state explainable by the human gate: a fact MUST NOT be
`aprovado` after a correction unless the reviewer is recorded or the bounded auto-approval holds.

#### Scenario: Operator lists every state

- GIVEN a customer with pending, approved, rejected, and superseded facts
- WHEN a vendor lists that customer's facts
- THEN all four rows MUST be returned together with their provenance

#### Scenario: Approval records the reviewer

- GIVEN a pending inferred fact
- WHEN a supervisor approves it
- THEN it MUST become `estado = 'aprovado'` with `revisado_por` set to the supervisor and
  `revisado_em` recorded

#### Scenario: Non-operator is refused

- GIVEN an authenticated caller whose function is `cliente` or who has no operator profile
- WHEN the caller invokes the list or review function
- THEN the call MUST fail with `42501`

#### Scenario: Rejection does not delete

- GIVEN a fact under review
- WHEN an operator rejects it
- THEN it MUST remain stored as `estado = 'rejeitado'`

### Requirement: Owner-scoped client access, correction, and refusal

A customer MUST be able to read their own approved facts, excluding `tipo = 'observacao'`, and to
correct or refuse an individual fact. Owner functions MUST resolve the customer through
`clientes.usuario_id = auth.uid()` and MUST NOT operate on another customer's facts. A correction
MUST set `origem = 'cliente'` and `estado = 'aprovado'`, because the customer's own statement is the
strongest provenance, and MUST leave exactly one live fact for that `(cliente_id, tipo, chave)`. A
refusal MUST set `estado = 'rejeitado'` and MUST retain the row.

Provenance MUST outrank recency for the same `(cliente_id, tipo, chave)`. The enforced trust order is
`cliente` > `operador` > `importado` > `ia`, and a candidate fact whose origin ranks strictly lower
than the live fact MUST NOT supersede it: the live fact MUST be returned unchanged and the candidate
MUST be discarded without a supersession or a new live row. Equal rank with an identical normalized
`valor` MUST likewise leave the live fact unchanged.

`tipo = 'observacao'` is internal and MUST NOT be returned to the customer by any client-facing
function.

#### Scenario: Customer reads own approved facts

- GIVEN a customer with approved facts, one of which is an internal `observacao`
- WHEN the customer reads their own facts
- THEN every approved fact MUST be returned except the `observacao` fact

#### Scenario: Customer correction becomes the strongest provenance

- GIVEN one of the customer's approved facts
- WHEN the customer corrects its value
- THEN the live fact MUST carry the corrected value, `origem = 'cliente'`, and `estado = 'aprovado'`
- AND no competing live fact MUST exist for the same `(cliente_id, tipo, chave)`

#### Scenario: A customer correction survives later inference

- GIVEN a live fact for a `(cliente_id, tipo, chave)` tuple with `origem = 'cliente'` holding the
  customer's corrected value
- WHEN model extraction later reports a value for the same key with `origem = 'ia'`
- THEN the live fact MUST remain the `origem = 'cliente'` fact with the corrected value
- AND the `ia` candidate MUST be discarded, because `cliente` outranks `ia` in the enforced trust
  order `cliente` > `operador` > `importado` > `ia`
- AND neither a supersession nor a new live row MUST occur for that key

#### Scenario: Customer refuses a fact

- GIVEN one of the customer's approved facts
- WHEN the customer refuses it
- THEN the row MUST become `estado = 'rejeitado'`
- AND the fact MUST NOT be returned by the customer surface or by the prompt surface

#### Scenario: Cross-customer access is refused

- GIVEN customer A authenticated and a fact belonging to customer B
- WHEN customer A corrects or refuses that fact
- THEN the call MUST fail with `42501`
- AND customer B's fact MUST remain unchanged

### Requirement: Approved-facts-only prompt read surface

The prompt read surface `buscar_fatos_para_prompt(p_cliente_id uuid)` MUST return only facts with
`estado = 'aprovado'` and `tipo <> 'observacao'`, and MUST be callable only by the backend service
role. Pending, rejected, and superseded facts MUST NOT be returned by any prompt read path.

#### Scenario: Pending inference is not knowledge

- GIVEN a customer with one approved fact and one pending inferred fact
- WHEN the prompt read surface is queried for that customer
- THEN it MUST return the approved fact only

#### Scenario: Internal notes never leave the system

- GIVEN an approved `observacao` fact
- WHEN the prompt read surface is queried
- THEN that fact MUST NOT be returned

### Requirement: Extraction after each completed turn

When the memory gate is enabled, Sofia MUST extract candidate facts once per processed batch, inside
the batch worker's post-completion step and after the completion call reports success. Extraction
MUST use a single economy-tier model call per batch — not per message — with structured JSON output
and a small output cap. Persisted facts MUST carry `origem = 'ia'`, `origem_conversa_id` set to the
originating conversation, and the model's confidence, and MUST reach `aprovado` or `pendente` only
through the bounded auto-approval invariant.

Extraction output MUST be validated server-side before persistence: `tipo` MUST be one of the five
permitted values, `chave` MUST satisfy the key regex, and `valor` MUST satisfy the length bound. A
candidate that fails validation MUST be discarded and MUST NOT be stored.

#### Scenario: One extraction call per batch

- GIVEN the gate is enabled and a batch containing several inbound messages is processed
- WHEN extraction runs
- THEN exactly one extraction model call MUST be made for that batch

#### Scenario: Extracted facts carry inference provenance

- GIVEN a batch whose conversation yields a customer preference
- WHEN the fact is persisted
- THEN it MUST carry `origem = 'ia'`, the originating conversation id, and a confidence value
- AND its state MUST be `aprovado` or `pendente` according to the auto-approval invariant

#### Scenario: Invalid candidates are discarded

- GIVEN a model response containing a candidate whose `tipo` is unknown, whose `chave` violates the
  regex, or whose `valor` exceeds the length bound
- WHEN extraction validates the response
- THEN the invalid candidate MUST NOT be persisted
- AND valid candidates from the same response MUST still be persisted

#### Scenario: Repeated extraction produces no second live fact

- GIVEN an existing fact for a `(cliente_id, tipo, chave)` tuple
- WHEN extraction runs again over a batch reporting the same fact
- THEN no second live fact MUST exist for that tuple

### Requirement: At-most-once extraction with no retry

Extraction MUST NOT retry on failure and MUST NOT be presented as guarded by a fence of its own. The
batch lease is already released when the post-completion step runs, so extraction is at-most-once by
completion semantics only: a crash between completion and extraction MUST lose that batch's facts.
The implementation MUST record that limitation instead of claiming a guarantee it does not provide. A
failed extraction MUST be logged, and neither the failure nor a recovered worker MUST cause a second
extraction attempt for the same batch or a duplicate fact.

#### Scenario: Failure is logged and not retried

- GIVEN the gate is enabled and the extraction model call fails for a completed batch
- WHEN the failure is handled
- THEN it MUST be logged
- AND no retry MUST be attempted for that batch
- AND the batch MUST remain completed and MUST NOT be re-claimed for extraction

#### Scenario: Crash after completion loses facts without regeneration

- GIVEN a batch that completes successfully and then fails before extraction starts
- WHEN later maintenance or recovery runs
- THEN extraction MUST NOT be re-triggered for that batch
- AND no fact MUST be created to compensate for the lost extraction

### Requirement: Default-closed feature gate

Extraction and prompt injection MUST both be controlled by the strict gate
`SOFIA_CUSTOMER_MEMORY_ENABLED`, following the `"true"`-only pattern of
`apps/web/src/lib/sofia/inbound-batch-gates.ts`. The gate MUST be closed unless its value is exactly
`"true"`. While the gate is closed, the system MUST preserve the existing behaviour unchanged: no
extraction model call MUST be made, no facts block MUST be added to the prompt, and facts MUST NOT be
read for prompt assembly.

#### Scenario: Absent or non-strict value keeps the gate closed

- GIVEN `SOFIA_CUSTOMER_MEMORY_ENABLED` is unset, `"TRUE"`, `"1"`, or `"yes"`
- WHEN a batch is processed
- THEN no extraction model call MUST be made
- AND the assembled prompt MUST be identical to the pre-change prompt

#### Scenario: Strict true opens both behaviours

- GIVEN `SOFIA_CUSTOMER_MEMORY_ENABLED = "true"`
- WHEN a batch completes and a prompt is assembled for a customer with approved facts
- THEN extraction MUST run once for that batch
- AND the approved facts block MUST be included in the prompt
