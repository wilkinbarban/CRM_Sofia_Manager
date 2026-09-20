# Delta for client-navigation

This delta adds a customer facts section to `/cliente/perfil`. It adds requirements only: the
existing layout, tab navigation, phone-verification gating, and middleware behaviour are unchanged.

## ADDED Requirements

### Requirement: Customer facts section in `/cliente/perfil`

`/cliente/perfil` MUST include a section where the authenticated customer can read their own
approved facts, excluding internal `observacao` notes, and can correct or refuse an individual fact.
The section MUST read and write only through the owner-scoped `memoria_cliente` functions, MUST NOT
disclose another customer's facts or internal notes, and MUST NOT bypass the existing
authentication, phone-verification, and middleware behaviour of the client area.

A corrected or refused fact MUST be reflected in the section on the next render, and a correction
MUST be presented as the customer's own statement.

#### Scenario: Customer sees own approved facts only

- GIVEN a verified customer with approved facts, one internal `observacao`, and another customer's
  facts
- WHEN the customer opens `/cliente/perfil`
- THEN the customer's approved facts MUST be listed
- AND the `observacao` fact and the other customer's facts MUST NOT be shown

#### Scenario: Customer corrects a fact from the profile

- GIVEN an approved fact listed in the customer's profile
- WHEN the customer corrects it
- THEN the section MUST show the corrected value
- AND the stored fact MUST carry `origem = 'cliente'` and `estado = 'aprovado'`

#### Scenario: Customer refuses a fact from the profile

- GIVEN an approved fact listed in the customer's profile
- WHEN the customer refuses it
- THEN the section MUST no longer list it
- AND the fact MUST NOT reach the approved-facts prompt surface

#### Scenario: Existing client-area gating is preserved

- GIVEN a logged-in customer whose phone is not verified
- WHEN the customer tries to open `/cliente/perfil`
- THEN the existing middleware MUST keep blocking access exactly as before the change
