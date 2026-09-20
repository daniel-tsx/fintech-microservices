# LedgerFlow

LedgerFlow is a production-oriented learning system for payment lifecycles, money correctness, and distributed failure handling. It deliberately separates payment orchestration from the append-only double-entry ledger and demonstrates idempotency, transactional outbox/inbox, at-least-once events, compensation, PSP uncertainty, settlement, and reconciliation.

This is an educational system, not a PCI-DSS-compliant payment product. It never stores card data and uses a deterministic PSP simulator.

## Start here

1. Read [LEARNING.md](LEARNING.md).
2. Read [docs/architecture.md](docs/architecture.md) and [docs/payment-flow.md](docs/payment-flow.md).
3. Run `pnpm install`, `pnpm test`, and a demo such as `pnpm demo:happy-payment`.
4. With Docker installed, copy `.env.example` to `.env` and run `docker compose up --build`.
5. Run `pnpm demo:payment-lifecycle` to authorize, capture, and refund through the real PSP/Payment/Kafka/Ledger path, restart services, replay Kafka events, and prove the Ledger remains unchanged.

The durable vertical slice is documented in [docs/outbox-inbox.md](docs/outbox-inbox.md); use [docs/database-debugging.md](docs/database-debugging.md) to inspect each PostgreSQL and Redpanda stage.

The first implementation pass prioritizes Payment, Wallet, Ledger, PSP, messaging patterns, webhooks, and reconciliation. Identity, customer profiles, notifications, and a public API gateway are described as deliberate next slices rather than represented by misleading empty services.
