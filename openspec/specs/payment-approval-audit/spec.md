# Delta for payment-approval-audit

## ADDED Requirements

### Requirement: Independent auditable approval
Payment status MUST remain independent from order status. Mercado Pago and authorized manual approvals MUST pass one atomic authority that records append-only source (`mercado_pago` or `manual`), actor, external reference/reason, timestamp, previous status, and new status. Repeated webhook deliveries or approval requests MUST be idempotent.

#### Scenario: Integration approval
- GIVEN a valid Mercado Pago approval for an existing order
- WHEN the webhook is processed
- THEN payment becomes `aprovado`, audit evidence is appended, and order status is unchanged.

#### Scenario: Manual approval authorization
- GIVEN an authorized operator and pending payment
- WHEN manual approval includes a reason
- THEN approval and immutable audit evidence commit atomically; unauthorized or reasonless requests fail.

#### Scenario: Duplicate notification
- GIVEN an already-recorded external reference
- WHEN the same webhook arrives again
- THEN no duplicate audit row or conflicting state is created.

## MODIFIED Requirements

### Requirement: Approved payment synchronization
The system MUST update `status_pagamento` to `aprovado` for an approved Mercado Pago payment, and MUST NOT update order `status` as a side effect.
(Previously: approved payment also set order status to `confirmado`.)

#### Scenario: Approved webhook
- GIVEN payment status `approved`
- WHEN webhook processing completes
- THEN payment is approved with provenance and order status remains unchanged.

## Requirements added by `multichannel-customer-payment-proofs`

## ADDED Requirements
### Requirement: Evidence-aware approval
Payment audit MUST distinguish `digital_proof` from `manual_external`, preserve Mercado Pago authority, reject direct/incomplete writes, and record actor, provenance, linked orders, confirmed cents, and outcome without sensitive logs.
#### Scenario: Digital proof
- GIVEN exact same-customer reconciliation
- WHEN authorized approval runs
- THEN payment events and evidence commit atomically.
#### Scenario: Incomplete evidence
- GIVEN neither valid proof reconciliation nor manual reason
- WHEN approval is attempted
- THEN payment remains unchanged.
