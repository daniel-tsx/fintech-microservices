# Failure and crash scenarios

Status: current Iteration 3 catalog.

## External payment uncertainty

| Failure | What happened / what we know | What we do not know | Stored state | Recovery / retry rule |
|---|---|---|---|---|
| Risk rejects | A deterministic business decision was received | nothing about PSP, because it was not called | `RISK_REJECTED` | terminal; do not authorize |
| PSP declines | Provider committed a negative business result | none | `AUTHORIZATION_DECLINED` | terminal for this payment intent |
| PSP HTTP 500 before effect | No success was returned; simulator did not create an operation | whether a real provider accepted before its 500 can be provider-specific | `AUTHORIZATION_FAILED` | provider contract determines retry; reuse operation ID |
| Timeout before processing | Transport deadline elapsed | whether request reached PSP until queried | `*_UNKNOWN` | query operation ID; `NOT_FOUND` permits same-ID retry |
| Timeout after success | PSP committed but response was lost | local caller cannot infer success from timeout | `*_UNKNOWN` | webhook or status query confirms success |
| Status API unavailable | No reliable external observation | external final state | remain `*_UNKNOWN` | defer; never convert absence of evidence into failure |
| Duplicate webhook | Same authentic event was delivered again | nothing new | one `webhook_events` row | acknowledge duplicate; one business effect |
| Out-of-order callback | Older provider sequence arrived late | network order has no business meaning | old row `IGNORED` | keep newer internal state |

## If the process crashes here

| Point | Durable outcome after restart |
|---|---|
| Payment exists before authorize is requested | `RISK_PENDING` remains. Creation and authorization are separate client commands; retry authorize is idempotent at later boundaries. |
| Risk approves but Payment dies before persisting | Payment remains `RISK_PENDING`; retry re-evaluates risk. Risk has no money side effect. |
| Operation is persisted, then Payment dies before PSP call | `payment_operations=PENDING` and payment `*_PENDING` survive; recovery queries PSP and safely sends the same operation ID if absent. |
| PSP receives/commits, then Payment dies before response | PSP record survives; local operation is pending. Recovery query or webhook converges it. |
| HTTP response is lost | local state becomes `*_UNKNOWN`; timeout is not treated as failure. |
| Webhook is persisted, then Payment dies | endpoint already returned 202; `webhook_events=PENDING` is leased by the restarted worker. |
| Webhook processor dies mid-transaction | webhook status, operation, payment, history, and outbox all roll back together. |
| Webhook transaction commits, process dies before outbox publication | pending outbox row survives and the restarted outbox worker publishes it. |
| Capture commits locally, process dies before Kafka publish | `CAPTURED` and `payment.captured.v1` outbox row survive atomically. |
| Kafka accepts, outbox worker dies before mark-published | event may be published again; Ledger `inbox_events` prevents another journal. |
| Ledger dies during inbox/journal transaction | inbox and all entries roll back; Kafka redelivery processes later. |
| Ledger commits, dies before offset commit | Kafka redelivers; inbox conflict returns `DUPLICATE`. |
| Refund commits at PSP, Payment restarts before local transition | PSP operation and queued webhook survive; Payment recovery queries the same refund operation and emits one refund fact. |

## Evidence map

- `payment.test.ts`: risk rejection, decline/system-error/unknown separation, same-ID recovery, webhook replay, race, out-of-order callback, capture/refund timeout recovery, duplicate operations, and over-refund rejection.
- `payment-state-machine.test.ts`: allowed transitions, terminal states, and forbidden regressions.
- `webhook.test.ts`: HMAC, constant-time-compatible encoding, stale timestamp, and stateless authenticity.
- `durable-payment.integration.ts`: PostgreSQL payment/outbox rollback, restart persistence, PSP operation restart idempotency, durable webhook deduplication, real Kafka duplicates, Ledger rollback, refund reversal, and database balance enforcement.
- `messaging.test.ts`: outbox retry and poison-event handling mechanics.

The integration test recreates schemas and must only target disposable databases. Infrastructure failover, multi-provider routing, automatic dead-letter remediation, and batch reconciliation remain outside this iteration.
