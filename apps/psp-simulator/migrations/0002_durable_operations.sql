ALTER TABLE psp_operations
  ADD COLUMN operation_id uuid,
  ADD COLUMN currency char(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN provider_sequence bigserial,
  ADD COLUMN scenario text NOT NULL DEFAULT 'SUCCESS',
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE psp_operations SET operation_id = id WHERE operation_id IS NULL;
ALTER TABLE psp_operations ALTER COLUMN operation_id SET NOT NULL;
ALTER TABLE psp_operations ADD CONSTRAINT psp_operations_operation_id_key UNIQUE (operation_id);
ALTER TABLE psp_operations ADD CONSTRAINT psp_operations_provider_sequence_key UNIQUE (provider_sequence);

ALTER TABLE pending_webhooks
  ADD COLUMN event_id uuid,
  ADD COLUMN operation_id uuid,
  ADD COLUMN payment_id uuid,
  ADD COLUMN provider_sequence bigint,
  ADD COLUMN locked_at timestamptz,
  ADD COLUMN locked_by text,
  ADD COLUMN last_error text;

CREATE INDEX pending_webhooks_delivery_idx ON pending_webhooks(deliver_after, attempt_count)
  WHERE delivered_at IS NULL;
