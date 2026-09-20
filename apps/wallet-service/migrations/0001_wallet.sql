CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  currency char(3) NOT NULL,
  available_minor bigint NOT NULL DEFAULT 0 CHECK (available_minor >= 0),
  pending_minor bigint NOT NULL DEFAULT 0 CHECK (pending_minor >= 0),
  version bigint NOT NULL DEFAULT 0,
  UNIQUE (owner_id, currency)
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  state text NOT NULL CHECK (state IN ('HELD','COMMITTED','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Production reservation query (single statement, concurrency-safe):
-- UPDATE wallets SET available_minor = available_minor - $1,
-- pending_minor = pending_minor + $1, version = version + 1
-- WHERE id = $2 AND available_minor >= $1 RETURNING *;
