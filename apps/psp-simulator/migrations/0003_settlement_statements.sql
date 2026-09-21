CREATE TABLE psp_settlement_statements (
  provider_settlement_id text PRIMARY KEY,
  statement jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
