# Concurrency

Status: in-memory lock and PostgreSQL strategy documented/tested.

Two concurrent spends must not both observe the same available balance. The local `WalletBook` serializes mutations for deterministic tests. The PostgreSQL migration documents the production operation:

```sql
UPDATE wallets
SET available_minor = available_minor - $1,
    pending_minor = pending_minor + $1,
    version = version + 1
WHERE id = $2 AND available_minor >= $1
RETURNING *;
```

Zero returned rows means missing wallet or insufficient funds. The predicate and update occur under one row lock; there is no check-then-act race. This is preferable to serializable transactions for a single-wallet debit because it is smaller and cheaper. Multi-wallet operations use ordered locks or a saga, never inconsistent lock ordering. See `tests/wallet-concurrency.test.ts`.
