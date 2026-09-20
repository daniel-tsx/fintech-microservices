# Observability

Status: correlation fields in contracts; exporters planned.

Every HTTP request should accept/generate `requestId` and `correlationId`; every event carries correlation and optional causation IDs. Structured logs should include service, operation, aggregate IDs, state transition, duration, and outcome—but never authorization headers, webhook secrets, or personal data.

Target metrics are payment outcomes/latency by stage, PSP unknown outcomes, outbox retry/dead-letter counts, consumer lag, ledger rejection count, reconciliation discrepancies by type/age, and stuck saga states. Histograms need bounded-cardinality labels; payment IDs belong in traces/logs, not metric labels.

OpenTelemetry propagation, Prometheus endpoints, and Grafana are not wired in this pass. Health endpoints distinguish liveness (process can run) from readiness (dependencies usable); current readiness explicitly reports the in-memory adapter.
