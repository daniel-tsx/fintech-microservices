CREATE TABLE psp_operations (
  id uuid PRIMARY KEY,
  intent_key text NOT NULL UNIQUE,
  external_payment_id uuid NOT NULL,
  internal_payment_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('AUTHORIZE','CAPTURE','REFUND')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL CHECK (status IN ('SUCCEEDED','DECLINED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pending_webhooks (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  deliver_after timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  delivered_at timestamptz
);
