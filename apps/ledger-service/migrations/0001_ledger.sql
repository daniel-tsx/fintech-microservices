CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY,
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','REVENUE','EXPENSE')),
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, account_type, currency)
);

CREATE TABLE ledger_journals (
  id uuid PRIMARY KEY,
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  reverses_journal_id uuid REFERENCES ledger_journals(id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reference_type, reference_id)
);

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY,
  journal_id uuid NOT NULL REFERENCES ledger_journals(id),
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_time_idx ON ledger_entries(account_id, created_at DESC);

-- A deferred database trigger in a hardened deployment should re-check that each
-- journal balances at COMMIT. The application posts all entries in one transaction.
