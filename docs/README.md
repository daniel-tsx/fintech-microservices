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

The Compose runtime uses PostgreSQL/Drizzle for Payment, the PSP simulator, and Ledger. Payment has a durable operation journal, explicit state machine, recovery worker, fast webhook inbox, transactional outbox, and Redpanda delivery. Ledger consumes capture/refund facts through an atomic inbox and append-only balanced journals. In-memory adapters remain fast test/learning tools. Wallet, batch reconciliation, authentication, metrics export, settlement, and other unrelated slices were deliberately not expanded in this iteration.
