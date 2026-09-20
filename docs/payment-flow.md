# Payment lifecycle and orchestration

Status: current for Iteration 3.

Payment Service is the workflow orchestrator. Risk owns a deterministic approve/reject decision, the PSP owns external authorize/capture/refund records, and Ledger owns immutable accounting. Risk and PSP commands are synchronous because Payment needs an immediate answer; PSP webhooks and Payment-to-Ledger events are asynchronous because delivery is delayed and at-least-once.

## State machine

All transitions pass through `payment-state-machine.ts`; repositories reject invalid changes and PostgreSQL also constrains the set of stored statuses. Terminal states are `RISK_REJECTED`, `AUTHORIZATION_DECLINED`, `REFUNDED`, and `CANCELLED`. `AUTHORIZATION_UNKNOWN`, `CAPTURE_UNKNOWN`, and `REFUND_UNKNOWN` require recovery. Failure states may be retried with the same logical operation where allowed.

```mermaid
stateDiagram-v2
  [*] --> RISK_PENDING
  RISK_PENDING --> RISK_APPROVED
  RISK_PENDING --> RISK_REJECTED
  RISK_APPROVED --> AUTHORIZATION_PENDING
  AUTHORIZATION_PENDING --> AUTHORIZED
  AUTHORIZATION_PENDING --> AUTHORIZATION_DECLINED
  AUTHORIZATION_PENDING --> AUTHORIZATION_FAILED
  AUTHORIZATION_PENDING --> AUTHORIZATION_UNKNOWN
  AUTHORIZATION_UNKNOWN --> AUTHORIZATION_PENDING: safe retry, same operation
  AUTHORIZATION_UNKNOWN --> AUTHORIZED: webhook/status query
  AUTHORIZATION_FAILED --> AUTHORIZATION_PENDING: retry
  AUTHORIZED --> CAPTURE_PENDING
  CAPTURE_PENDING --> CAPTURED
  CAPTURE_PENDING --> CAPTURE_FAILED
  CAPTURE_PENDING --> CAPTURE_UNKNOWN
  CAPTURE_UNKNOWN --> CAPTURE_PENDING: safe retry, same operation
  CAPTURE_UNKNOWN --> CAPTURED: webhook/status query
  CAPTURED --> REFUND_PENDING
  REFUND_PENDING --> PARTIALLY_REFUNDED
  REFUND_PENDING --> REFUNDED
  REFUND_PENDING --> REFUND_FAILED
  REFUND_PENDING --> REFUND_UNKNOWN
  REFUND_UNKNOWN --> REFUND_PENDING: safe retry, same operation
  REFUND_UNKNOWN --> PARTIALLY_REFUNDED: webhook/status query
  REFUND_UNKNOWN --> REFUNDED: webhook/status query
  PARTIALLY_REFUNDED --> REFUND_PENDING
```

## Happy authorize and capture

```mermaid
sequenceDiagram
  participant C as Client
  participant P as Payment
  participant D as Payment PostgreSQL
  participant R as Risk
  participant X as PSP PostgreSQL
  participant K as Redpanda
  participant L as Ledger PostgreSQL
  C->>P: create + API Idempotency-Key
  P->>D: tx: payment + idempotency + outbox
  C->>P: authorize
  P->>R: evaluate(paymentId, customer, amount)
  R-->>P: APPROVE
  P->>D: tx: RISK_APPROVED + history + outbox
  P->>D: tx: authorization operation + AUTHORIZATION_PENDING
  P->>X: authorize(operationId)
  X->>X: insert provider operation once
  X-->>P: SUCCEEDED + providerSequence
  P->>D: tx: operation + AUTHORIZED + history + outbox
  C->>P: capture + API Idempotency-Key
  P->>D: tx: capture operation + CAPTURE_PENDING
  P->>X: capture(same stable operationId on retry)
  X-->>P: SUCCEEDED
  P->>D: tx: operation + CAPTURED + history + outbox
  D-->>K: outbox worker publishes payment.captured.v1
  K-->>L: at-least-once delivery
  L->>L: tx: inbox + journal + balanced entries
```

Risk rejection ends at `RISK_REJECTED` and no PSP operation is created. A PSP decline is a normal `AUTHORIZATION_DECLINED` business result. A provider HTTP 5xx with no accepted operation is `AUTHORIZATION_FAILED`. A timeout or network loss is `AUTHORIZATION_UNKNOWN` because the external effect may exist.

## PSP succeeds but the response is lost

```mermaid
sequenceDiagram
  participant P as Payment
  participant X as PSP
  participant D as Payment PostgreSQL
  P->>D: tx: operation PENDING + AUTHORIZATION_PENDING
  P->>X: authorize(operationId=O1)
  X->>X: commit O1 as SUCCEEDED
  X--xP: HTTP response lost
  P->>D: tx: operation UNKNOWN + AUTHORIZATION_UNKNOWN
  Note over P,D: We know the response was not observed.<br/>We do not know whether the PSP committed.
  P->>X: GET provider-transactions/O1
  X-->>P: SUCCEEDED
  P->>D: tx: operation SUCCEEDED + AUTHORIZED + history + outbox
```

`TIMEOUT != FAILURE`. Payment stores uncertainty rather than inventing a negative result. Recovery queries by the original operation ID. If the PSP says `NOT_FOUND`, retry is safe only because the retry reuses that same ID. A new ID would be a new financial intent and could double-charge.

## Webhook-before-response race

```mermaid
sequenceDiagram
  participant P as HTTP request
  participant X as PSP
  participant W as Webhook worker
  participant D as Payment PostgreSQL
  P->>X: capture(operationId=O2)
  X->>W: signed CAPTURED webhook
  W->>D: tx: lock operation/payment, mark O2 SUCCEEDED, CAPTURED, outbox
  X-->>P: HTTP SUCCEEDED
  P->>D: lock O2; already SUCCEEDED, return current payment
  Note over P,D: The late HTTP result cannot overwrite the newer state.
```

Both paths lock the operation and payment rows in the same order. Operation terminality, provider sequence, the state machine, and optimistic payment version prevent regression.

## Refund

```mermaid
sequenceDiagram
  participant C as Client
  participant P as Payment
  participant X as PSP
  participant K as Redpanda
  participant L as Ledger
  C->>P: refund(amount) + Idempotency-Key
  P->>P: validate remaining captured amount
  P->>P: tx: refund operation + REFUND_PENDING + requested outbox
  P->>X: refund(refund operationId)
  X-->>P: SUCCEEDED / DECLINED / UNKNOWN
  P->>P: tx: update operation/payment/history + result outbox
  P-->>K: payment.refunded.v1
  K-->>L: event (may repeat)
  L->>L: tx: inbox + new REFUND journal + reversed entries
```

Partial refunds are supported sequentially; `refundedAmountMinor` may never exceed `capturedAmountMinor`. Refunds append new debit/credit entries and link to the original capture journal. Historical entries are never edited.

## Important atomic and concurrency boundaries

- `create`: payment, client idempotency record, initial history, and outbox event commit together.
- `beginOperation`: durable operation, pending payment state, history, and optional requested event commit together before the PSP call.
- `resolveOperation`: provider outcome, payment state, history, and integration outbox commit together.
- `processWebhook`: webhook status, operation result, payment state, history, and outbox commit together.
- Ledger: Kafka inbox, journal, and entries commit together.
- External PSP HTTP cannot share a database transaction with Payment. Stable operation IDs plus query/webhook recovery bridge that unavoidable gap.

Implementation entry points: `apps/payment-service/src/payment.application.ts`, `payment-state-machine.ts`, `postgres-payment.repository.ts`, `recovery.worker.ts`, `apps/psp-simulator/src/postgres-psp.repository.ts`, and `apps/ledger-service/src/postgres-ledger.repository.ts`.
