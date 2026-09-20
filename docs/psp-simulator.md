# PSP simulator

Status: domain simulator and HTTP commands implemented.

`PspSimulator` supports success, decline, timeout before effect, slow success, and success followed by timeout. Operations use a stable intent key `(operation, paymentId, amount)` and replay the first outcome rather than duplicating it.

`SUCCESS_THEN_TIMEOUT` is the most important scenario: the external record exists while Payment remains pending. The correct response is webhook/reconciliation, not blind retry. Delayed/out-of-order webhook scheduling is represented in the PSP schema but the delivery worker is not wired yet.

Use `POST /v1/simulator/scenarios` to queue the next behavior. This control surface is local-test-only and must never be exposed in a real processor integration.
