ALTER TABLE outbox_events
  ADD COLUMN locked_at timestamptz,
  ADD COLUMN locked_by text,
  ADD COLUMN dead_lettered_at timestamptz;

DROP INDEX outbox_unpublished_idx;
CREATE INDEX outbox_unpublished_idx
  ON outbox_events(available_at, created_at)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX outbox_lease_recovery_idx
  ON outbox_events(locked_at)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;
