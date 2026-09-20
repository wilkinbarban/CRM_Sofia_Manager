# Delta for crm_vendas

This delta extends the operator chat workspace with a customer facts review surface. It adds
requirements only; the existing client details behaviour (`endereco`, `tags`, `notas`) is unchanged.

## ADDED Requirements

### Requirement: Operator fact review surface for the selected customer

The operator chat workspace MUST offer a customer facts review surface for the selected customer,
alongside the existing client details panel. The surface MUST list facts in every state (`pendente`,
`aprovado`, `rejeitado`, `substituido`) with their `tipo`, `chave`, `valor`, `origem`, `confianca`,
and originating conversation, and MUST let the operator approve, reject, or correct a fact.
Rejection and supersession MUST keep the row as history.

Access MUST follow the existing operator authorization (`verificarOperadorAutorizado()`) and the
`atualizarClienteCrm` / `ClientCrmPanel.tsx` pattern. All reads and writes MUST go through the
`memoria_cliente` function surface; the surface MUST NOT read `public.fatos_cliente` directly. The
existing `endereco`, `tags`, and `notas` editing MUST keep its current behaviour and MUST NOT be
replaced by the facts surface.

#### Scenario: Vendor reviews a pending inference

- GIVEN an operator authorized to use the workspace and a customer with a pending inferred fact
- WHEN the operator opens the facts review surface
- THEN the pending fact MUST be listed with `origem = 'ia'` and its confidence
- AND the operator MUST be able to approve or reject it

#### Scenario: Approval is attributed to the operator

- GIVEN a pending fact under review
- WHEN the operator approves it
- THEN the stored fact MUST become `estado = 'aprovado'` with `revisado_por` and `revisado_em`
  recorded
- AND it MUST be readable by the approved-facts prompt surface

#### Scenario: Correction stays explainable by the human gate

- GIVEN a pending inferred fact
- WHEN the operator corrects its value and approves it
- THEN the stored fact MUST remain explainable as human-reviewed through `revisado_por`
- AND the corrected value MUST be the value read by the prompt surface

#### Scenario: Unauthorized caller is blocked

- GIVEN an authenticated caller without operator authorization
- WHEN the caller requests the surface or invokes its review path
- THEN access MUST be denied and no customer fact MUST be disclosed

#### Scenario: Existing client details behaviour is preserved

- GIVEN an operator with a customer selected in the workspace
- WHEN the facts review surface is added
- THEN editing and saving `endereco`, `tags`, and `notas` MUST keep working exactly as before
