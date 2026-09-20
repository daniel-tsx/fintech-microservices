# Inspecting the durable Payment-to-Ledger flow

Status: current for the Compose runtime.

## Start and trace the slice

Copy `.env.example` to `.env`, keep the local-only webhook secret, then run:

```bash
docker compose up -d --build postgres redpanda migrations risk-service psp-simulator payment-service ledger-service
docker compose ps
docker compose logs -f payment-service ledger-service
```

Or run `pnpm demo:durable-payment`. The demo creates, authorizes, and captures a payment; waits for the ledger; restarts Payment and Ledger; replays the captured envelope through Redpanda; and verifies that journal/entry counts do not change. It intentionally leaves services running for inspection.

`scripts/migrate.ts` applies ordered, checksummed migrations. If it finds a database created by the repository's earlier pre-runner Compose version, it baselines the existing `0001` schema and then applies later migrations.

## Payments database

Open an interactive shell:

```bash
docker compose exec postgres psql -U ledgerflow -d payments
```

Useful queries:

```sql
SELECT id, wallet_id, merchant_id, status, amount_minor, currency, version, updated_at
FROM payments
ORDER BY created_at DESC;

SELECT key, request_hash, payment_id, created_at
FROM idempotency_keys
ORDER BY created_at DESC;

SELECT id,
       payload->>'eventId' AS event_id,
       payload->>'eventType' AS event_type,
       aggregate_id AS payment_id,
       attempts, available_at, locked_at, locked_by, published_at,
       dead_lettered_at, last_error
FROM outbox_events
ORDER BY created_at;

SELECT event_id, error, failed_at
FROM dead_letter_events
ORDER BY failed_at DESC;
```

A committed payment with `published_at IS NULL` is not lost; it is durable pending work. A non-null `locked_at` is an active or abandoned lease. After 30 seconds an abandoned lease is claimable by a restarted worker.

## Ledger database

```bash
docker compose exec postgres psql -U ledgerflow -d ledger
```

```sql
SELECT event_id, event_type, correlation_id, processed_at
FROM inbox_events
ORDER BY processed_at;

SELECT id, reference_type, reference_id AS payment_id,
       source_event_id, correlation_id, posted_at
FROM ledger_journals
ORDER BY posted_at;

SELECT e.journal_id, e.account_id, a.owner_type, a.owner_id,
       a.account_type, e.direction, e.amount_minor, e.currency, e.created_at
FROM ledger_entries e
JOIN ledger_accounts a ON a.id = e.account_id
ORDER BY e.created_at;

SELECT journal_id,
       SUM(amount_minor) FILTER (WHERE direction = 'DEBIT') AS debits,
       SUM(amount_minor) FILTER (WHERE direction = 'CREDIT') AS credits
FROM ledger_entries
GROUP BY journal_id
ORDER BY journal_id;
```

For a captured payment there should be one journal, exactly two equal entries, and one inbox row whose `event_id` equals `ledger_journals.source_event_id`.

## Redpanda / Kafka

```bash
docker compose exec redpanda rpk topic list --brokers redpanda:9092
docker compose exec redpanda rpk topic describe ledgerflow.payments.v1 --brokers redpanda:9092
docker compose exec redpanda rpk topic consume ledgerflow.payments.v1 --brokers redpanda:9092 --offset start
```

Stop the consumer with Ctrl+C. Messages are JSON envelopes. Compare `eventId`, `correlationId`, and `aggregateId` with the outbox, logs, inbox, and journal.

## Focused status checks

```bash
docker compose exec postgres psql -U ledgerflow -d payments -c "SELECT status, count(*) FROM payments GROUP BY status ORDER BY status"
docker compose exec postgres psql -U ledgerflow -d payments -c "SELECT count(*) AS pending FROM outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL"
docker compose exec postgres psql -U ledgerflow -d ledger -c "SELECT count(*) AS inbox_events FROM inbox_events"
docker compose exec postgres psql -U ledgerflow -d ledger -c "SELECT count(*) AS journals FROM ledger_journals"
```

Use `docker compose restart payment-service` or `docker compose restart ledger-service` to test process restart. Do not remove the PostgreSQL volume if the goal is to observe durability; `docker compose down -v` intentionally deletes it.
