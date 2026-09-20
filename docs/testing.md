# Testing strategy

Status: current.

Fast deterministic tests protect financial invariants and failure decisions without infrastructure. Run `pnpm test`. Current suites cover ledger balance/reversal, payment idempotency/state transitions, PSP ambiguous outcomes, webhook replay/staleness, wallet concurrency, transfer compensation, inbox/outbox behavior, and reconciliation.

Integration tests against PostgreSQL and Redpanda are the next gate. They must prove unique-key races, atomic state+outbox commit, `FOR UPDATE SKIP LOCKED` workers, inbox effect atomicity, consumer restart, migration application, and real HTTP raw-body signatures. Docker is unavailable on the authoring machine, so Compose has not been started or claimed as verified.

Money tests should prefer invariants over snapshots: total debits equal credits, refunded never exceeds captured, captured never exceeds authorized, and available/pending never become negative.
