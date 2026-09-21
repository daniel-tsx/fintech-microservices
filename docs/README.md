# Documentation index

Status: current for the learning-core implementation.

| Goal | Read |
|---|---|
| System boundaries | [architecture.md](architecture.md), [services.md](services.md) |
| Payment and PSP uncertainty | [payment-flow.md](payment-flow.md), [psp-simulator.md](psp-simulator.md), [webhooks.md](webhooks.md) |
| Money correctness | [ledger.md](ledger.md), [concurrency.md](concurrency.md) |
| Distributed reliability | [messaging.md](messaging.md), [outbox-inbox.md](outbox-inbox.md), [idempotency.md](idempotency.md), [saga.md](saga.md) |
| Operations | [reconciliation.md](reconciliation.md), [settlement.md](settlement.md), [observability.md](observability.md) |
| Inspect the durable slice | [database-debugging.md](database-debugging.md) |
| Assurance | [failure-scenarios.md](failure-scenarios.md), [security.md](security.md), [testing.md](testing.md) |

The Compose runtime uses PostgreSQL for Payment, PSP, Ledger, and Reconciliation. PSP produces durable signed statements; Reconciliation persists batches, leased runs, evidence history, discrepancies, repair audit, and a transactional outbox; Ledger consumes capture/refund/settlement/repair facts through one atomic inbox and append-only balanced journals. In-memory adapters remain fast test/learning tools. Wallet persistence, full identity/authorization, metrics export, merchant payout, chargebacks, and unrelated slices were deliberately not expanded.
