# Testing strategy

Status: current.

Fast deterministic tests protect financial invariants and failure decisions without infrastructure. Run `pnpm test`. Current suites cover ledger balance/reversal, payment idempotency/state transitions, PSP ambiguous outcomes, webhook replay/staleness, wallet concurrency, transfer compensation, inbox/outbox behavior, and reconciliation.

Run `pnpm test:integration` while PostgreSQL databases `payments`/`ledger` and Kafka are available at the URLs in `PAYMENT_TEST_DATABASE_URL`, `LEDGER_TEST_DATABASE_URL`, and `KAFKA_TEST_BROKERS`. The default endpoints match Compose's host ports. `tests/integration/durable-payment.integration.ts` uses real PostgreSQL and Kafka: no database or broker mocks participate in the important path.

The suite proves payment/outbox rollback on an injected mid-transaction failure, persistence across database reconnect, real Kafka publication and consumption, outbox lease recovery after a simulated post-publish crash, duplicate Kafka delivery, atomic Ledger inbox/effect rollback, idempotent redelivery, and the PostgreSQL deferred balance constraint. It runs sequentially and recreates the two test schemas, so point it only at disposable local databases.

The repository uses existing Compose infrastructure instead of Testcontainers: it keeps the runtime and test broker/database configuration identical and avoids another orchestration dependency. `pnpm demo:durable-payment` exercises service restarts and an explicit event replay through Redpanda.

Money tests should prefer invariants over snapshots: total debits equal credits, refunded never exceeds captured, captured never exceeds authorized, and available/pending never become negative.
