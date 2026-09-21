# Inspecting the payment lifecycle

Status: current for the Compose runtime.

Start the focused slice:

```bash
docker compose up -d --build postgres redpanda migrations risk-service psp-simulator payment-service ledger-service
docker compose logs -f payment-service psp-simulator ledger-service
```

Copy `.env.example` to `.env` first and use a local-only webhook secret. `pnpm demo:durable-payment` exercises the flow and leaves services running. Never run `docker compose down -v` when inspecting durability because it deliberately deletes the PostgreSQL volume.

## Payment database

```bash
docker compose exec postgres psql -U ledgerflow -d payments
```

```sql
SELECT id, status, authorized_amount_minor, captured_amount_minor,
       refunded_amount_minor, external_payment_id, provider_sequence,
       failure_code, version, updated_at
FROM payments ORDER BY created_at DESC;

SELECT id AS operation_id, payment_id, operation_type, status,
       amount_minor, idempotency_key, attempt_count, external_payment_id,
       provider_sequence, failure_code, resolution_source,
       last_attempt_at, resolved_at, updated_at
FROM payment_operations ORDER BY created_at;

SELECT payment_id, previous_status, next_status, source,
       operation_id, reason, created_at
FROM payment_state_history ORDER BY created_at;

SELECT event_id, event_type, operation_id, payment_id, provider_sequence,
       processing_status, attempt_count, locked_by, last_error,
       received_at, processed_at
FROM webhook_events ORDER BY received_at;

SELECT id, payload->>'eventType' AS event_type, aggregate_id AS payment_id,
       attempts, published_at, dead_lettered_at, last_error
FROM outbox_events ORDER BY created_at;
```

For timeout-after-success, before recovery expect Payment `AUTHORIZATION_UNKNOWN`, operation `UNKNOWN`, and a PSP `SUCCEEDED` row. After webhook/status recovery expect Payment `AUTHORIZED`, operation `SUCCEEDED`, `resolution_source` of `WEBHOOK` or `RECOVERY`, an additional history row, and a `payment.authorized.v1` outbox row.

## PSP database

```bash
docker compose exec postgres psql -U ledgerflow -d psp
```

```sql
SELECT operation_id, internal_payment_id AS payment_id, operation,
       amount_minor, currency, status, provider_sequence, scenario,
       external_payment_id, created_at, updated_at
FROM psp_operations ORDER BY provider_sequence;

SELECT id AS delivery_id, event_id, operation_id, payment_id,
       provider_sequence, deliver_after, attempt_count, locked_by,
       delivered_at, last_error
FROM pending_webhooks ORDER BY deliver_after;
```

One `operation_id` must produce one PSP row even after retry. An undelivered webhook row survives PSP restart.

## Ledger database

```bash
docker compose exec postgres psql -U ledgerflow -d ledger
```

```sql
SELECT event_id, event_type, correlation_id, processed_at
FROM inbox_events ORDER BY processed_at;

SELECT id, reference_type, reference_id, source_event_id,
       reverses_journal_id, correlation_id, posted_at
FROM ledger_journals ORDER BY posted_at;

SELECT j.reference_type, j.reference_id, e.account_id, a.owner_type,
       a.account_type, e.direction, e.amount_minor, e.currency
FROM ledger_entries e
JOIN ledger_journals j ON j.id = e.journal_id
JOIN ledger_accounts a ON a.id = e.account_id
ORDER BY j.posted_at, e.direction;

SELECT journal_id,
       SUM(amount_minor) FILTER (WHERE direction = 'DEBIT') AS debits,
       SUM(amount_minor) FILTER (WHERE direction = 'CREDIT') AS credits
FROM ledger_entries GROUP BY journal_id ORDER BY journal_id;
```

Authorization creates no journal. Capture creates one `PAYMENT` journal. Refund creates a distinct `REFUND` journal whose `reverses_journal_id` references the capture journal. Every row must show equal debit and credit totals.

## Kafka and restart inspection

```bash
docker compose exec redpanda rpk topic describe ledgerflow.payments.v1 --brokers redpanda:9092
docker compose exec redpanda rpk topic consume ledgerflow.payments.v1 --brokers redpanda:9092 --offset start
docker compose restart psp-simulator payment-service ledger-service
```

Trace `requestId`, `correlationId`, `paymentId`, operation ID, and `eventId` across logs and tables. A pending outbox or webhook row is durable work, not a lost event.

## Settlement and reconciliation database

```bash
docker compose exec postgres psql -U ledgerflow -d reconciliation
```

```sql
SELECT id, provider, provider_settlement_id, status, window_start, window_end,
       currency, item_count, gross_total_minor, fee_total_minor,
       net_total_minor, signature_verified, integrity_errors, completed_at
FROM settlement_batches ORDER BY created_at;

SELECT id, batch_id, provider_item_id, provider_transaction_id, payment_id,
       operation_id, operation_type, gross_amount_minor, fee_amount_minor,
       net_amount_minor, currency, provider_status, status, last_error
FROM settlement_items ORDER BY batch_id, id;

SELECT id, run_key, provider, settlement_batch_id, status, checkpoint,
       matched_count, mismatch_count, auto_repair_count, manual_review_count,
       lease_owner, lease_expires_at, started_at, completed_at
FROM reconciliation_runs ORDER BY created_at;

SELECT run_id, item_key, payment_id, provider_transaction_id,
       result, evidence_digest, checked_at
FROM reconciliation_items ORDER BY checked_at;

SELECT id, discrepancy_type, severity, repair_classification, payment_id,
       provider_transaction_id, status, first_detected_at, last_detected_at,
       observation_count, resolved_at, resolution, resolved_by
FROM reconciliation_discrepancies ORDER BY last_detected_at;

SELECT discrepancy_id, run_id, expected, actual, evidence_digest, observed_at
FROM discrepancy_observations ORDER BY observed_at;

SELECT discrepancy_id, action, actor, automatic, status, previous_state,
       resulting_state, evidence, correlation_id, created_at, completed_at
FROM repair_actions ORDER BY created_at;

SELECT id, topic, payload->>'eventType' event_type, aggregate_id,
       attempts, published_at, dead_lettered_at, last_error
FROM outbox_events ORDER BY created_at;
```

### Walkthrough: capture exists but Ledger is missing

1. Confirm `payments.status = 'CAPTURED'`, the capture operation is `SUCCEEDED`, and the PSP row with that `operation_id` is `SUCCEEDED`.
2. Confirm there is no Ledger `PAYMENT` journal for the payment ID using the Ledger queries above.
3. Generate/fetch the statement, then run `POST /v1/reconciliation/runs` with `x-operator-token`. Inspect the `LEDGER_ENTRY_MISSING` discrepancy and its first observation.
4. Call `POST /v1/reconciliation/discrepancies/:id/retry-repair`. Inspect the `repair_actions` row and `ledgerflow.repairs.v1` outbox row.
5. In Ledger, observe one inbox row, one `PAYMENT` journal, and balanced entries. Replaying the repair event does not add another journal.
6. Resolve the discrepancy through the operator API. A later matching run leaves the old observation and repair action intact.

Do not manually `INSERT` Ledger entries or update Payment status while debugging. Those shortcuts bypass invariants and destroy the audit trail.
