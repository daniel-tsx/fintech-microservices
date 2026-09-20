# LedgerFlow learning map

1. **Boundaries:** read `docs/architecture.md`, `docs/services.md`, and ADRs 001–003.
2. **Payment lifecycle:** read `payment.application.ts`, `docs/payment-flow.md`, then run `pnpm demo:happy-payment`.
3. **Ledger:** read `ledger.domain.ts`, its migration, `docs/ledger.md`, and `tests/ledger.test.ts`.
4. **Events:** read `packages/contracts`, `packages/platform/src/kafka.ts`, and `docs/messaging.md`.
5. **Outbox/inbox:** read `outbox.ts`, `inbox.ts`, payment migration, and `messaging.test.ts`.
6. **Idempotency:** trace `PaymentApplication.create` through its repository and run the payment tests.
7. **Saga/eventual consistency:** read `transfer.saga.ts`, `docs/saga.md`, and `docs/consistency.md`.
8. **Failures/retries:** run every `demo:*` script and map results to `docs/failure-scenarios.md`.
9. **Reconciliation/settlement:** read the comparator, migration, and the two operational docs.
10. **Observability/security:** identify the explicit gaps in those docs before adding new features.

Suggested exercise: wire the payment PostgreSQL adapter first, prove state+outbox atomicity in an integration test, then wire the outbox publisher to Redpanda. Do not start with UI.
