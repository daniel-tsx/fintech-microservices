# Failure scenarios

Status: current test/demo catalog.

| Failure | System response | Evidence |
|---|---|---|
| Same payment request twice | Replay same payment; one outbox fact | `payment.test.ts` |
| Same key, different body | Reject | `payment.test.ts` |
| Concurrent overspend | One reservation wins | `wallet-concurrency.test.ts` |
| PSP succeeds, response times out | Remain pending; reconcile/webhook | `payment.test.ts`, `demo:payment-timeout` |
| Duplicate webhook | Signature replay/inbox rejects effect | `webhook.test.ts` |
| Duplicate Kafka event | Inbox returns `DUPLICATE` | `messaging.test.ts` |
| Poison message | Bounded retry then DLQ | `messaging.test.ts` |
| Unbalanced journal | Domain rejects; PostgreSQL also rejects at commit | `ledger.test.ts`, `durable-payment.integration.ts` |
| Ledger unavailable during transfer | Release source hold | `transfer-saga.test.ts` |
| PSP/internal mismatch | Open discrepancy | `reconciliation.test.ts` |

## Durable Payment-to-Ledger crash matrix

| Case | Crash/failure point | Durable result | Evidence |
|---|---|---|---|
| A | Payment transaction fails after payment insert | Transaction rolls back: no payment, idempotency, or outbox row | injected repository probe in `durable-payment.integration.ts` |
| B | Payment commits; worker has not published; Payment stops | Payment and pending outbox row survive; lease-based worker publishes after restart | reconnect integration test; `demo:durable-payment` restarts Payment |
| C | Kafka publish fails | `published_at` stays null; attempt/error/backoff recorded; later polling retries | `OutboxPublisher` unit tests and `PostgresOutboxStore` |
| D | Kafka accepts; worker dies before marking | Lease expires; restarted worker republishes the same `eventId` | real Kafka integration test deliberately omits `markPublished` |
| E | Ledger receives the same event twice | one inbox row, one journal, two entries | real Kafka duplicate-publication integration test and durable demo replay |
| F | Ledger fails after inbox insert but before commit | inbox and ledger writes both roll back; redelivery later succeeds | injected Ledger transaction probe integration test |
| G | Ledger commits then dies before offset commit | Kafka redelivers; inbox conflict prevents another journal | same real Kafka duplicate test exercises the equivalent durable state |

The demo and tests cover the important application crash windows, not infrastructure failover. Database failover, Redpanda multi-node replication, poison-event replay operations, webhook delivery recovery, and durable transfer saga recovery remain future focused slices.
