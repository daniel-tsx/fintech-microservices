# Testing strategy

Status: current for Iteration 3.

Run fast deterministic coverage with `pnpm test`. It uses in-memory Payment/PSP adapters only where no infrastructure boundary is under test. It covers the state machine, happy lifecycle, risk rejection, PSP decline versus system error versus unknown, timeout before/after processing, same-operation recovery, webhook authenticity, replay, out-of-order delivery, HTTP/webhook convergence, duplicate capture/refund, partial/full refund, over-refund, Ledger balance, and messaging mechanics.

Run `pnpm test:integration` only against disposable PostgreSQL databases and Kafka. The suite drops and recreates the target `public` schemas. Configure:

```text
PAYMENT_TEST_DATABASE_URL=postgres://.../ledgerflow_it_payments
LEDGER_TEST_DATABASE_URL=postgres://.../ledgerflow_it_ledger
PSP_TEST_DATABASE_URL=postgres://.../ledgerflow_it_psp
KAFKA_TEST_BROKERS=127.0.0.1:19092
```

The integration suite uses real PostgreSQL for Payment, PSP, and Ledger and real Kafka for the important event path. It proves:

- payment/idempotency/outbox rollback on an injected mid-transaction error;
- persistence across a database connection restart;
- one PSP row for a stable operation ID across restart/retry;
- durable webhook replay protection and atomic state/history/outbox resolution;
- outbox lease recovery after Kafka accepted but publication was not marked;
- duplicate Kafka delivery creates one Ledger journal;
- Ledger inbox and entries roll back together on injected failure;
- refund creates a new balanced reversal journal and duplicate refund events are ignored;
- the PostgreSQL deferred balance constraint rejects an unbalanced journal.

The current deterministic matrix is split intentionally: protocol-independent decisions run fast in unit tests; durability, locking, constraints, and broker behavior run against real infrastructure. The Compose runtime is reused rather than adding Testcontainers.

`pnpm demo:durable-payment` starts the real slice, executes authorize/capture/refund, restarts services, replays Kafka events, and leaves state available for inspection. Scenario demos in `scripts/demo.ts` make uncertainty and webhook concepts visible without infrastructure.

Verification records must distinguish execution from static readiness. On a host without Docker or disposable database credentials, `pnpm test:integration` and service demos are not verified merely because they compile.
