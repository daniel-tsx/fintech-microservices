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

The Compose runtime uses PostgreSQL/Drizzle for Payment and Ledger, a polling transactional-outbox worker, and a real Redpanda consumer with an atomic Ledger inbox. The in-memory Payment and Ledger implementations remain fast test/learning adapters. Wallet, reconciliation, PSP persistence, authentication, metrics export, settlement, and the other planned slices were deliberately not productionized in this iteration.
