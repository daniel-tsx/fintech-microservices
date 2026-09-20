# Consistency model

Status: current.

Strong consistency is local to one service transaction. Payment state + outbox, wallet conditional reservation, and ledger journal + entries are local atomic units. Everything across services is eventually consistent.

The API exposes intermediate states (`RISK_PENDING`, `AUTHORIZATION_PENDING`, `CAPTURE_PENDING`, `REFUND_PENDING`) and uncertain states (`AUTHORIZATION_UNKNOWN`, `CAPTURE_UNKNOWN`, `REFUND_UNKNOWN`) rather than pretending an asynchronous flow completed. Consumers must render pending/unknown honestly and poll/read status or accept a later notification.

The external PSP, Payment, Wallet, and Ledger can temporarily disagree. Reconciliation is the safety net, not an exceptional afterthought. The cost is operational complexity and stale reads; the benefit is availability without unsafe distributed transactions.
