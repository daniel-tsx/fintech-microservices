ALTER TABLE reconciliation_runs DROP CONSTRAINT reconciliation_runs_status_check;
ALTER TABLE reconciliation_runs
  ADD COLUMN run_key char(64), ADD COLUMN provider text NOT NULL DEFAULT 'LEDGERFLOW_PSP',
  ADD COLUMN settlement_batch_id uuid, ADD COLUMN source_digest char(64), ADD COLUMN checkpoint text,
  ADD COLUMN matched_count integer NOT NULL DEFAULT 0, ADD COLUMN mismatch_count integer NOT NULL DEFAULT 0,
  ADD COLUMN auto_repair_count integer NOT NULL DEFAULT 0, ADD COLUMN manual_review_count integer NOT NULL DEFAULT 0,
  ADD COLUMN lease_owner text, ADD COLUMN lease_expires_at timestamptz, ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT reconciliation_runs_status_check CHECK (status IN ('CREATED','RUNNING','PARTIALLY_COMPLETED','COMPLETED','FAILED'));
UPDATE reconciliation_runs SET run_key = rpad(replace(id::text, '-', ''), 64, '0'), started_at = created_at WHERE run_key IS NULL;
ALTER TABLE reconciliation_runs ALTER COLUMN run_key SET NOT NULL;
ALTER TABLE reconciliation_runs ADD CONSTRAINT reconciliation_runs_run_key_key UNIQUE (run_key);

-- Preserve Iteration 1 demo evidence without leaving two active discrepancy tables.
ALTER TABLE discrepancies RENAME TO legacy_discrepancies;

CREATE TABLE settlement_batches (
  id uuid PRIMARY KEY, provider text NOT NULL, provider_settlement_id text NOT NULL, statement_digest char(64) NOT NULL,
  statement_signature text NOT NULL, window_start timestamptz NOT NULL, window_end timestamptz NOT NULL, currency char(3) NOT NULL,
  status text NOT NULL CHECK (status IN ('CREATED','PROCESSING','PARTIALLY_MATCHED','RECONCILED','REQUIRES_REVIEW','COMPLETED','FAILED')),
  item_count integer NOT NULL CHECK (item_count >= 0), gross_total_minor bigint NOT NULL,
  fee_total_minor bigint NOT NULL CHECK (fee_total_minor >= 0), net_total_minor bigint NOT NULL,
  signature_verified boolean NOT NULL, integrity_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE (provider, provider_settlement_id)
);

CREATE TABLE settlement_items (
  id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES settlement_batches(id), provider_item_id text NOT NULL,
  provider_transaction_id text NOT NULL, payment_id uuid, operation_id uuid,
  operation_type text CHECK (operation_type IN ('CAPTURE','REFUND')), gross_amount_minor bigint,
  fee_amount_minor bigint, net_amount_minor bigint, currency text, provider_status text,
  status text NOT NULL CHECK (status IN ('PENDING','MATCHED','MISMATCHED','POSTING','SETTLED','MALFORMED')),
  last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, provider_item_id)
);
CREATE INDEX settlement_items_batch_status_idx ON settlement_items(batch_id, status, id);
CREATE INDEX settlement_items_provider_transaction_idx ON settlement_items(provider_transaction_id);
ALTER TABLE reconciliation_runs ADD CONSTRAINT reconciliation_runs_settlement_batch_fk FOREIGN KEY (settlement_batch_id) REFERENCES settlement_batches(id);

CREATE TABLE reconciliation_items (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES reconciliation_runs(id), item_key text NOT NULL,
  payment_id uuid, provider_transaction_id text, settlement_item_id uuid REFERENCES settlement_items(id),
  result text NOT NULL CHECK (result IN ('MATCHED','MISMATCHED','SKIPPED_GRACE_PERIOD')),
  evidence_digest char(64) NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), UNIQUE (run_id, item_key)
);
CREATE INDEX reconciliation_items_run_idx ON reconciliation_items(run_id, id);

CREATE TABLE reconciliation_discrepancies (
  id uuid PRIMARY KEY, fingerprint char(64) NOT NULL UNIQUE, discrepancy_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  repair_classification text NOT NULL CHECK (repair_classification IN ('SAFE_AUTO_REPAIR','REQUIRES_REVIEW')),
  payment_id uuid, provider_transaction_id text, settlement_item_id uuid REFERENCES settlement_items(id),
  status text NOT NULL CHECK (status IN ('OPEN','ACKNOWLEDGED','UNDER_REVIEW','RESOLVED','FALSE_POSITIVE','ESCALATED')),
  first_detected_at timestamptz NOT NULL DEFAULT now(), last_detected_at timestamptz NOT NULL DEFAULT now(),
  observation_count integer NOT NULL DEFAULT 1, resolved_at timestamptz, resolution text, resolved_by text
);
CREATE INDEX reconciliation_discrepancies_open_idx ON reconciliation_discrepancies(status, last_detected_at) WHERE status NOT IN ('RESOLVED','FALSE_POSITIVE');
CREATE INDEX reconciliation_discrepancies_payment_idx ON reconciliation_discrepancies(payment_id, last_detected_at);

CREATE TABLE discrepancy_observations (
  id uuid PRIMARY KEY, discrepancy_id uuid NOT NULL REFERENCES reconciliation_discrepancies(id),
  run_id uuid NOT NULL REFERENCES reconciliation_runs(id), expected jsonb, actual jsonb,
  evidence_digest char(64) NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), UNIQUE (discrepancy_id, run_id)
);
CREATE INDEX discrepancy_observations_discrepancy_idx ON discrepancy_observations(discrepancy_id, observed_at);

CREATE TABLE repair_actions (
  id uuid PRIMARY KEY, discrepancy_id uuid NOT NULL REFERENCES reconciliation_discrepancies(id),
  action text NOT NULL CHECK (action IN ('ACKNOWLEDGE','MARK_FALSE_POSITIVE','RETRY_RECONCILIATION','APPLY_SAFE_REPAIR','ESCALATE','RESOLVE')),
  actor text NOT NULL, automatic boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','EMITTED','SUCCEEDED','REJECTED','FAILED')),
  previous_state jsonb, resulting_state jsonb, evidence jsonb, correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX repair_actions_discrepancy_idx ON repair_actions(discrepancy_id, created_at);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY, topic text NOT NULL, aggregate_id uuid NOT NULL, payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz,
  locked_by text, published_at timestamptz, dead_lettered_at timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_outbox_pending_idx ON outbox_events(available_at, created_at) WHERE published_at IS NULL AND dead_lettered_at IS NULL;
CREATE TABLE dead_letter_events (event_id uuid PRIMARY KEY, payload jsonb NOT NULL, error text NOT NULL, failed_at timestamptz NOT NULL DEFAULT now());
