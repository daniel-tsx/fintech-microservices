# Documentation index

Status: current for the learning-core implementation.

| Goal | Read |
|---|---|
| System boundaries | [architecture.md](architecture.md), [services.md](services.md) |
| Payment and PSP uncertainty | [payment-flow.md](payment-flow.md), [psp-simulator.md](psp-simulator.md), [webhooks.md](webhooks.md) |
| Money correctness | [ledger.md](ledger.md), [concurrency.md](concurrency.md) |
| Distributed reliability | [messaging.md](messaging.md), [outbox-inbox.md](outbox-inbox.md), [idempotency.md](idempotency.md), [saga.md](saga.md) |
| Operations | [reconciliation.md](reconciliation.md), [settlement.md](settlement.md), [observability.md](observability.md) |
| Assurance | [failure-scenarios.md](failure-scenarios.md), [security.md](security.md), [testing.md](testing.md) |

The executable HTTP adapters currently use in-memory repositories so the domain behavior can be studied without infrastructure. SQL migrations define the intended PostgreSQL-owned stores. Wiring Drizzle PostgreSQL repositories, Kafka consumers, authentication, metrics export, and settlement persistence is explicitly not yet done; do not confuse schema presence with runtime persistence.
