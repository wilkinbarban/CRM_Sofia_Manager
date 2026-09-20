# Delta for dashboard_admin

This delta extends the administrative LGPD deletion authority so that it covers the new
`public.fatos_cliente` table. It adds requirements only; existing authorization, anti-lockout, audit
logging, and the total-purge path keep their current behaviour.

**Recorded non-goal.** The pre-existing retention gap for operator free-text `clientes.notas` under
anonymization is not addressed here. It predates this change and is tracked as a follow-up candidate
for a later slice; no requirement below claims to fix it.

## ADDED Requirements

### Requirement: Anonymization removes the anonymized customer's facts

`public.anonymizar_usuario_admin(p_usuario_alvo_id uuid)` MUST delete the `public.fatos_cliente` rows
belonging to the target customer's client record. The deletion MUST happen before, or atomically
with, clearing `clientes.usuario_id`, because once that column is nulled the link from the user to the
client no longer exists and the facts become unreachable through that path.

The function's existing authorization (`public.tem_funcoes` including `admin`), its anti-lockout
rule, and its audit-log entry MUST be preserved. Facts belonging to every other customer MUST survive
the call.

#### Scenario: Anonymization purges the target customer's facts

- GIVEN a customer with facts, and other customers with their own facts
- WHEN an admin anonymizes that customer's user
- THEN the target customer's `fatos_cliente` rows MUST be deleted
- AND every other customer's facts MUST remain unchanged
- AND the call MUST still record its audit entry and still clear the profile fields it clears today

#### Scenario: Ordering does not lose the facts

- GIVEN the target customer's facts exist while `clientes.usuario_id` still points at the anonymized
  user
- WHEN the anonymization runs
- THEN the facts MUST be deleted within the same call
- AND after the call no fact row MUST remain reachable for that customer

#### Scenario: Unauthorized caller changes nothing

- GIVEN an authenticated caller without the `admin` function
- WHEN the caller invokes the anonymization function
- THEN the call MUST fail with `42501`
- AND no fact row MUST be deleted

### Requirement: Total purge keeps removing facts through the cascade

The total purge path (`iniciar_purga_total_usuario_admin` and its downstream jobs) MUST continue to
remove the customer's facts through the `on delete cascade` foreign key from `public.fatos_cliente`
when the customer row is deleted. The change MUST NOT require, and MUST NOT weaken, that cascade.

#### Scenario: Purge leaves no facts behind

- GIVEN a customer with facts
- WHEN the total purge completes and deletes the customer row
- THEN no `fatos_cliente` row MUST remain for that customer

#### Scenario: Purge does not touch other customers

- GIVEN a purge of one customer and other customers holding facts
- WHEN the purge completes
- THEN the other customers' facts MUST remain unchanged
