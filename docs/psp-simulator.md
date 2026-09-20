# PSP simulator failure laboratory

Status: durable and wired in the Compose runtime.

The PSP simulator owns PostgreSQL tables `psp_operations` and `pending_webhooks`. `operationId` is the provider idempotency identity and `provider_sequence` is a monotonic provider version. Retrying AUTHORIZE, CAPTURE, or REFUND with the same operation ID returns the first stored result; it never inserts another financial operation. Payment persists the operation ID before calling the PSP and reuses it for HTTP retry, status query, webhook matching, and history.

| Scenario | PSP effect | HTTP observation | Webhook |
|---|---|---|---|
| `SUCCESS` | committed | success | none |
| `DECLINE` | committed decline | decline | none |
| `HTTP_500` | none | 500 | none |
| `TIMEOUT_BEFORE_PROCESSING` | none | caller times out | none |
| `TIMEOUT_AFTER_PROCESSING` | committed | caller times out | queued |
| `SLOW_SUCCESS` / `SLOW_DECLINE` | committed | delayed result | scenario-dependent result |
| `WEBHOOK_BEFORE_HTTP_RESPONSE` | committed | success after webhook is accepted | immediate |
| `WEBHOOK_AFTER_HTTP_RESPONSE` | committed | success first | delayed |
| `DUPLICATE_WEBHOOK` | one operation | success | same event ID twice |
| `DELAYED_WEBHOOK` | committed | success | delayed one second |
| `OUT_OF_ORDER_WEBHOOK` | committed | success | newer callback, then older authorization |
| `HTTP_RESPONSE_LOST_AFTER_SUCCESS` | committed | caller times out | queued |

Scenarios are deterministic per request through `x-test-psp-scenario` on Payment or `scenario` on the simulator request. Payment rejects the test header unless `ALLOW_PSP_TEST_SCENARIOS=true`; Compose enables it for the learning environment. `POST /v1/simulator/scenarios` remains a convenience for manually queuing the next simulator behavior and must never be exposed as a real provider API.

## Safe versus unsafe retry

- Safe: query `GET /v1/provider-transactions/O1`; if absent, resend the identical command with `Idempotency-Key: O1` and body `operationId: O1`.
- Unsafe: generate `O2` because the request carrying `O1` timed out. Both can commit.
- Ambiguous: the status endpoint is unavailable. Keep `UNKNOWN`; do not reinterpret missing evidence as failure.

The PSP webhook scheduler stores payload, due time, attempt count, lease, and last error. Its worker acknowledges a delivery only after Payment returns 2xx. A process restart leaves undelivered rows available for a later lease.

Limitations: this is a single-provider learning model; scenario selection queued through the control API is process-local, provider sequence is global rather than per provider object, and no provider authentication exists on Payment-to-PSP HTTP beyond the operation idempotency key. The durable per-request scenario path used by tests does not depend on randomness.
