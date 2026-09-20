ALTER TABLE payments DROP CONSTRAINT payments_status_check;

UPDATE payments SET status = CASE status
  WHEN 'RISK_CHECKING' THEN 'RISK_PENDING'
  WHEN 'FAILED' THEN 'AUTHORIZATION_FAILED'
  ELSE status
END;

ALTER TABLE payments
  ADD COLUMN customer_id uuid,
  ADD COLUMN provider_sequence bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT payments_status_check CHECK (status IN (
    'RISK_PENDING','RISK_APPROVED','RISK_REJECTED',
    'AUTHORIZATION_PENDING','AUTHORIZED','AUTHORIZATION_DECLINED','AUTHORIZATION_FAILED','AUTHORIZATION_UNKNOWN',
    'CAPTURE_PENDING','CAPTURED','CAPTURE_FAILED','CAPTURE_UNKNOWN',
    'REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED','REFUND_FAILED','REFUND_UNKNOWN','CANCELLED'
  ));

CREATE TABLE payment_operations (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  operation_type text NOT NULL CHECK (operation_type IN ('AUTHORIZE','CAPTURE','REFUND')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  idempotency_key varchar(255) NOT NULL UNIQUE,
  request_hash char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','DECLINED','FAILED','UNKNOWN')),
  attempt_count integer NOT NULL DEFAULT 0,
  external_payment_id uuid,
  provider_sequence bigint,
  failure_code text,
  resolution_source text CHECK (resolution_source IN ('HTTP','WEBHOOK','RECOVERY')),
  last_attempt_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_operations_recovery_idx ON payment_operations(status, updated_at);

CREATE TABLE payment_state_history (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  previous_status text,
  next_status text NOT NULL,
  source text NOT NULL,
  operation_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_state_history_payment_idx ON payment_state_history(payment_id, created_at);

INSERT INTO payment_state_history (id, payment_id, previous_status, next_status, source, created_at)
SELECT gen_random_uuid(), id, NULL, status, 'MIGRATION', updated_at FROM payments;

CREATE TABLE webhook_events (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  operation_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  provider_sequence bigint NOT NULL,
  payload jsonb NOT NULL,
  processing_status text NOT NULL DEFAULT 'PENDING' CHECK (processing_status IN ('PENDING','PROCESSED','IGNORED')),
  attempt_count integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX webhook_events_pending_idx ON webhook_events(processing_status, received_at);
