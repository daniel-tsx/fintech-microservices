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
| Unbalanced journal | Reject before append | `ledger.test.ts` |
| Ledger unavailable during transfer | Release source hold | `transfer-saga.test.ts` |
| PSP/internal mismatch | Open discrepancy | `reconciliation.test.ts` |

Still to test after durable adapters: process crash between each database statement, broker outage during outbox drain, webhook-before-response over HTTP, DLQ replay after key retention, database failover, and durable saga recovery.
