# Delta for rag_conhecimento

This delta adds a second, per-customer knowledge source to Sofia's prompt assembly. It changes no
existing retrieval behaviour: global `public.base_conhecimento` retrieval, the persona system
prompt, the conversation history, and the language rules keep their current semantics.

## ADDED Requirements

### Requirement: Per-customer facts block in Sofia prompt assembly

When the customer memory gate is enabled and the current customer has approved facts, the assembled
Sofia system prompt MUST include one per-customer facts block, sourced only from the approved-facts
prompt read surface of `memoria_cliente`, placed between the active-orders context
(`contextoPedidosAtivos`) and the conversation history (`HISTÓRICO DA CONVERSA`) in
`apps/web/src/lib/ai/openrouter.ts`.

The block MUST be rendered as clearly labeled customer-provided data. It MUST be bounded to at most
20 facts and at most 1200 characters of rendered fact content; the design intent is "roughly", and
these numbers are the normative upper bound. The block MUST NOT be presented as policy: global
`base_conhecimento` articles remain the only authority for policy, price, hours, and product facts,
and a conflict between a customer fact and a global article MUST resolve in favour of the global
article.

Pending, rejected, and superseded facts, and `tipo = 'observacao'` notes, MUST NOT appear in the
block.

#### Scenario: Approved fact reaches the prompt in the right position

- GIVEN the memory gate is enabled and the customer has an approved `endereco` fact
- WHEN the Sofia prompt is assembled
- THEN the facts block MUST appear after the active-orders context and before the conversation
  history
- AND it MUST contain the approved fact

#### Scenario: Unapproved facts never reach the model

- GIVEN a customer with one pending, one rejected, and one superseded fact
- WHEN the Sofia prompt is assembled
- THEN none of those facts MUST appear in the prompt

#### Scenario: Internal notes never reach the model

- GIVEN an approved fact with `tipo = 'observacao'`
- WHEN the Sofia prompt is assembled
- THEN it MUST NOT appear in the prompt

#### Scenario: Customer facts stay subordinate to global knowledge

- GIVEN an approved customer fact that conflicts with an article of `public.base_conhecimento`
- WHEN the prompt is assembled and rendered
- THEN the customer fact MUST be labeled as customer-provided context
- AND the block MUST NOT be placed in, or represented as, the global knowledge section

#### Scenario: The block is capped

- GIVEN a customer with more than 20 approved facts whose rendered text exceeds 1200 characters
- WHEN the prompt is assembled
- THEN the block MUST contain no more than 20 facts and no more than 1200 characters of rendered
  fact content

#### Scenario: Closed gate leaves prompt assembly unchanged

- GIVEN `SOFIA_CUSTOMER_MEMORY_ENABLED` is not exactly `"true"`
- WHEN the Sofia prompt is assembled
- THEN no facts block MUST be added
- AND no fact MUST be read for prompt assembly
- AND no additional model call MUST be made
