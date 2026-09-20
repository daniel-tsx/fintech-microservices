# Double-entry ledger

Status: current domain and schema.

Every journal contains at least two entries, one currency, positive integer minor-unit amounts, and equal debit/credit totals. `assertBalanced` enforces the invariant before append. PostgreSQL constraints enforce positive amounts and immutable references; a production adapter must insert the journal and entries in one transaction and add a deferred commit-time balance trigger.

```mermaid
erDiagram
  LEDGER_ACCOUNT ||--o{ LEDGER_ENTRY : receives
  LEDGER_JOURNAL ||--|{ LEDGER_ENTRY : contains
  LEDGER_JOURNAL o|--o| LEDGER_JOURNAL : reverses
  LEDGER_ACCOUNT { uuid id PK; text account_type; char currency }
  LEDGER_JOURNAL { uuid id PK; text reference_type; uuid reference_id UK; uuid reverses_journal_id }
  LEDGER_ENTRY { uuid id PK; uuid journal_id FK; uuid account_id FK; text direction; bigint amount_minor }
```

- Ledger balance is the sum of immutable entries and is the financial source of truth.
- Available balance is what a wallet permits spending after holds.
- Pending balance is held for incomplete flows.
- Wallet balances are operational projections; they can be rebuilt/reconciled from ledger facts plus active holds.

Corrections append a reversing journal; they never edit history. Duplicate business references replay the original journal. Money is an integer number of minor units in TypeScript and `bigint` in PostgreSQL; JavaScript floating point is never used.
