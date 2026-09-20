# ADR 006: Transactional outbox and inbox

Status: accepted.

## Context
PostgreSQL and Kafka cannot be committed atomically by the application.

## Decision
Commit state and an outbox record together, publish later, and deduplicate consumers with an inbox in their effect transaction.

## Alternatives
Publish inside the database transaction still permits split-brain outcomes. Dual writes after commit can lose events. Broker “exactly once” does not cover arbitrary databases.

## Consequences
Delivery is at-least-once, duplicates are normal, and workers/DLQs add operations. Business state never silently commits without durable publication intent.
