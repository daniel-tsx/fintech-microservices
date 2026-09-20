# Observability

Status: structured tracing logs wired for the durable Payment-to-Ledger slice; exporters planned.

Every HTTP request should accept/generate `requestId` and `correlationId`; every event carries correlation and optional causation IDs. Structured logs should include service, operation, aggregate IDs, state transition, duration, and outcome—but never authorization headers, webhook secrets, or personal data.

Target metrics are payment outcomes/latency by stage, PSP unknown outcomes, outbox retry/dead-letter counts, consumer lag, ledger rejection count, reconciliation discrepancies by type/age, and stuck saga states. Histograms need bounded-cardinality labels; payment IDs belong in traces/logs, not metric labels.

Payment logs the HTTP request, committed payment/outbox state, and publish outcome with `requestId`, `correlationId`, `eventId`, and `paymentId` where applicable. Ledger logs Kafka topic/partition/offset, inbox result, correlation, event, and payment IDs. `structuredLog` is implemented in `packages/platform/src/logging.ts`; the runtime call sites are `apps/payment-service/src/main.ts`, `apps/payment-service/src/outbox.worker.ts`, and `apps/ledger-service/src/kafka-ledger.consumer.ts`.

OpenTelemetry, Prometheus, and Grafana remain out of scope. Payment and Ledger readiness now check PostgreSQL and worker/consumer state rather than reporting an in-memory adapter.
