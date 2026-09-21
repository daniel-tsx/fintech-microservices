# LedgerFlow learning map

1. **Boundaries:** read `docs/architecture.md`, `docs/services.md`, and ADRs 001–003.
2. **Payment lifecycle:** read `payment.application.ts`, `docs/payment-flow.md`, then run `pnpm demo:happy-payment`.
3. **Ledger:** read `ledger.domain.ts`, its migration, `docs/ledger.md`, and `tests/ledger.test.ts`.
4. **Events:** read `packages/contracts`, `packages/platform/src/kafka.ts`, and `docs/messaging.md`.
5. **Outbox/inbox:** read `outbox.ts`, `inbox.ts`, payment migration, and `messaging.test.ts`.
6. **Idempotency:** trace `PaymentApplication.create` through its repository and run the payment tests.
7. **Saga/eventual consistency:** read `transfer.saga.ts`, `docs/saga.md`, and `docs/consistency.md`.
8. **Failures/retries:** run every `demo:*` script and map results to `docs/failure-scenarios.md`.
9. **Reconciliation/settlement:** follow the Iteration 4 path below; this is now a durable slice, not an in-memory comparator.
10. **Observability/security:** identify the explicit gaps in those docs before adding new features.

Suggested exercise: wire the payment PostgreSQL adapter first, prove state+outbox atomicity in an integration test, then wire the outbox publisher to Redpanda. Do not start with UI.

## Iteration 4: settlement when sources disagree

Study in this order:

1. `docs/settlement.md` — capture versus settlement and the clearing journal.
2. `apps/psp-simulator/src/settlement-statement.ts` — deterministic fees, controlled bad statements, HMAC, and totals.
3. `apps/reconciliation-service/migrations/0002_settlement_and_reconciliation.sql` — durable batch, run, item, discrepancy, observation, repair, lease, and outbox identities.
4. `apps/reconciliation-service/src/reconciliation.service.ts` — the five-source matching algorithm and safe/manual classification.
5. `docs/reconciliation.md` — source authority, timing windows, discrepancy lifecycle, and crash behavior.
6. `apps/reconciliation-service/src/reconciliation.store.ts` — statement/run idempotency, item transaction boundary, history, repair audit, and settlement outbox.
7. `apps/ledger-service/src/postgres-ledger.repository.ts` — capture, refund, settlement, and repair all end at the Ledger-owned inbox transaction.
8. `apps/ledger-service/src/kafka-ledger.consumer.ts` — at-least-once delivery and offset acknowledgement after commit.
9. `tests/reconciliation.test.ts` and `tests/settlement.test.ts` — scenario matrix and accounting invariants.
10. `tests/integration/settlement-reconciliation.integration.ts` — real PostgreSQL uniqueness, leases, restart safety, and history.

Run `pnpm demo:settlement-happy-path`, then intentionally compare it with `pnpm demo:reconciliation-ledger-missing`, `pnpm demo:duplicate-settlement`, and `pnpm demo:manual-review-mismatch`. Ask at every arrow: which database committed, what identity makes retry safe, and which source is only evidence rather than absolute truth?
