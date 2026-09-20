CREATE TABLE payments (
  id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','RISK_CHECKING','AUTHORIZATION_PENDING','AUTHORIZED','CAPTURE_PENDING','CAPTURED','FAILED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED')),
  authorized_amount_minor bigint NOT NULL DEFAULT 0 CHECK (authorized_amount_minor >= 0),
  captured_amount_minor bigint NOT NULL DEFAULT 0 CHECK (captured_amount_minor >= 0),
  refunded_amount_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_amount_minor >= 0),
  external_payment_id uuid,
  failure_code text,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (refunded_amount_minor <= captured_amount_minor),
  CHECK (captured_amount_minor <= authorized_amount_minor)
);
CREATE INDEX payments_status_updated_idx ON payments(status, updated_at);
CREATE UNIQUE INDEX payments_external_id_idx ON payments(external_payment_id) WHERE external_payment_id IS NOT NULL;

CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  request_hash char(64) NOT NULL,
  payment_id uuid NOT NULL REFERENCES payments(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  topic text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_unpublished_idx ON outbox_events(available_at, created_at) WHERE published_at IS NULL;

CREATE TABLE inbox_events (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dead_letter_events (
  event_id uuid PRIMARY KEY,
  payload jsonb NOT NULL,
  error text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);
