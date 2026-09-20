ALTER TABLE ledger_journals
  ADD COLUMN source_event_id uuid UNIQUE;

CREATE TABLE inbox_events (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  correlation_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION assert_balanced_journal(target_journal_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  entry_count integer;
  currency_count integer;
  debit_total numeric;
  credit_total numeric;
BEGIN
  SELECT COUNT(*), COUNT(DISTINCT currency),
         COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0),
         COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)
    INTO entry_count, currency_count, debit_total, credit_total
  FROM ledger_entries
  WHERE journal_id = target_journal_id;

  IF entry_count < 2 OR currency_count <> 1 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'ledger journal % is unbalanced (entries %, currencies %, debits %, credits %)',
      target_journal_id, entry_count, currency_count, debit_total, credit_total
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION check_journal_row_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_balanced_journal(NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION check_entry_journal_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_balanced_journal(OLD.journal_id);
    RETURN OLD;
  END IF;
  PERFORM assert_balanced_journal(NEW.journal_id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_journal_balance_on_journal
AFTER INSERT OR UPDATE ON ledger_journals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_journal_row_balance();

CREATE CONSTRAINT TRIGGER ledger_journal_balance_on_entries
AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_entry_journal_balance();
