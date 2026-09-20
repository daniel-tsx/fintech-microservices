# Double-entry ledger

Status: durable Payment-capture posting wired; general domain API remains available.

Every journal contains at least two entries, one currency, positive integer minor-unit amounts, and equal debit/credit totals. `assertBalanced` enforces the invariant in the domain. PostgreSQL checks positive amounts, and migration `0002_inbox_and_balance.sql` installs deferred constraint triggers that re-evaluate the complete journal at commit. The durable adapter inserts its journal and entries in one transaction, so an unbalanced commit fails with SQLSTATE `23514`.

```mermaid
erDiagram
  LEDGER_ACCOUNT ||--o{ LEDGER_ENTRY : receives
  LEDGER_JOURNAL ||--|{ LEDGER_ENTRY : contains
  INBOX_EVENT ||--o| LEDGER_JOURNAL : deduplicates
  LEDGER_JOURNAL o|--o| LEDGER_JOURNAL : reverses
  LEDGER_ACCOUNT { uuid id PK; text account_type; char currency }
  LEDGER_JOURNAL { uuid id PK; text reference_type; uuid reference_id UK; uuid source_event_id UK; uuid reverses_journal_id }
  LEDGER_ENTRY { uuid id PK; uuid journal_id FK; uuid account_id FK; text direction; bigint amount_minor }
  INBOX_EVENT { uuid event_id PK; text event_type; uuid correlation_id }
```

- Ledger balance is the sum of immutable entries and is the financial source of truth.
- Available balance is what a wallet permits spending after holds.
- Pending balance is held for incomplete flows.
- Wallet balances are operational projections; they can be rebuilt/reconciled from ledger facts plus active holds.

Corrections append a reversing journal; they never edit history. Duplicate business references replay the original journal. Money is an integer number of minor units in TypeScript and `bigint` in PostgreSQL; JavaScript floating point is never used.

For `payment.captured.v1`, `PostgresLedgerRepository.processPaymentCaptured` debits a processor-clearing ASSET account and credits a merchant-payable LIABILITY account by the same `amountMinor`. The inbox row and both entries share the transaction. A duplicate `eventId` returns `DUPLICATE` without appending anything.
