ALTER TABLE payment_operations DROP CONSTRAINT payment_operations_resolution_source_check;
ALTER TABLE payment_operations ADD CONSTRAINT payment_operations_resolution_source_check
  CHECK (resolution_source IN ('HTTP','WEBHOOK','RECOVERY','RECONCILIATION'));
