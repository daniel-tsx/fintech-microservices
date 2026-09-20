CREATE TABLE reconciliation_runs (
  id uuid PRIMARY KEY,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discrepancies (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES reconciliation_runs(id),
  payment_id uuid NOT NULL,
  discrepancy_type text NOT NULL,
  expected jsonb,
  actual jsonb,
  status text NOT NULL CHECK (status IN ('OPEN','UNDER_REVIEW','RESOLVED')),
  resolution_note text,
  detected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discrepancies_open_idx ON discrepancies(status, detected_at) WHERE status <> 'RESOLVED';
