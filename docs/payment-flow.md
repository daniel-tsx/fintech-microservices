# Payment flow

Status: current.

```mermaid
sequenceDiagram
  participant C as Client
  participant P as Payment
  participant R as Risk
  participant X as PSP
  participant K as Redpanda
  participant L as Ledger
  C->>P: POST /payments + Idempotency-Key
  P->>P: atomically store payment + PaymentCreated outbox
  P-->>C: RISK_CHECKING
  C->>P: POST /payments/{id}/authorize
  P->>R: evaluate
  R-->>P: approve/reject + reason codes
  P->>P: AUTHORIZATION_PENDING before external call
  P->>X: authorize(stable payment intent)
  alt definitive response
    X-->>P: approved/declined
    P->>P: persist terminal transition + outbox
  else timeout / unknown
    X--xP: response lost
    P-->>C: AUTHORIZATION_PENDING
    X-->>P: signed webhook later
  end
  P-->>K: PaymentAuthorized/Captured
  K-->>L: at-least-once event
  L->>L: inbox claim + balanced journal transaction
```

```mermaid
stateDiagram-v2
  [*] --> RISK_CHECKING
  RISK_CHECKING --> FAILED: rejected
  RISK_CHECKING --> AUTHORIZATION_PENDING: approved
  AUTHORIZATION_PENDING --> AUTHORIZED: response/webhook
  AUTHORIZATION_PENDING --> FAILED: decline
  AUTHORIZED --> CAPTURE_PENDING
  CAPTURE_PENDING --> CAPTURED: response/webhook
  CAPTURE_PENDING --> AUTHORIZED: definitive capture failure
  CAPTURED --> REFUND_PENDING
  PARTIALLY_REFUNDED --> REFUND_PENDING
  REFUND_PENDING --> PARTIALLY_REFUNDED
  REFUND_PENDING --> REFUNDED
```

Implementation: `apps/payment-service/src/payment.application.ts`. A timeout never proves failure; blind retry could double-charge. The stable internal payment ID is the PSP intent identity, so the simulator deduplicates retried operations.
