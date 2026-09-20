# Service responsibilities

Status: current.

| Service | Owns | Must not own |
|---|---|---|
| Payment | Payment state machine, client idempotency, PSP intent/outcome, payment outbox | Wallet balance, accounting balance |
| Wallet | Available/pending projections, reservations, transfer orchestration | Immutable accounting history |
| Ledger | Accounts, append-only journals and entries, reversals | Payment lifecycle decisions |
| Risk | Deterministic limits, velocity history, block decisions | Payment mutation |
| PSP simulator | External operations and webhook schedule | Internal payment truth |
| Reconciliation | Runs, discrepancies, manual-review state | Silent automatic money repair |

Identity/Auth, Customer, Notification, API Gateway, and a separately deployed Settlement service were evaluated but are not stubbed. Authentication/customer profiles are orthogonal to the first money-correctness slice; notification consumes facts but teaches little before messaging is fully wired; a gateway would add proxy code without changing current contracts; settlement belongs beside reconciliation until its own throughput and lifecycle justify separation. See ADR 001.

Shared packages contain only event contracts and platform mechanics. They do not contain entities or repositories, preserving ownership.
