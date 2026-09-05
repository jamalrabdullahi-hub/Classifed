-- Ledger invariants, enforced by the database rather than by convention.
--
-- The application also asserts all of this in src/services/ledger.ts. The
-- duplication is deliberate: a bug, a migration script, or a hand-run UPDATE
-- must not be able to corrupt the books.

-- ---------------------------------------------------------------------------
-- 1. Entry amounts are strictly positive. Direction carries the sign.
-- ---------------------------------------------------------------------------
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_positive" CHECK ("amount" > 0);

-- ---------------------------------------------------------------------------
-- 2. Append-only. Corrections are reversing entries, never edits.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'ledger is append-only: % on % is forbidden. Post a reversing transaction instead.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();

CREATE TRIGGER ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();

-- ---------------------------------------------------------------------------
-- 3. Every transaction balances, per asset, and has at least two entries.
--
-- DEFERRABLE INITIALLY DEFERRED so the check runs once at COMMIT, after all
-- legs of the journal entry have been inserted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger AS $$
DECLARE
  entry_count INTEGER;
  offending   RECORD;
BEGIN
  SELECT COUNT(*) INTO entry_count
  FROM "ledger_entries" e
  WHERE e."transactionId" = NEW."transactionId";

  -- Zero means the transaction was rolled back; nothing to check.
  IF entry_count = 0 THEN
    RETURN NULL;
  END IF;

  IF entry_count < 2 THEN
    RAISE EXCEPTION
      'ledger transaction % has % entry; double entry requires at least 2',
      NEW."transactionId", entry_count
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT e."assetId" AS asset_id,
         SUM(CASE WHEN e."direction" = 'DEBIT' THEN e."amount" ELSE -e."amount" END) AS net
  INTO offending
  FROM "ledger_entries" e
  WHERE e."transactionId" = NEW."transactionId"
  GROUP BY e."assetId"
  HAVING SUM(CASE WHEN e."direction" = 'DEBIT' THEN e."amount" ELSE -e."amount" END) <> 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'ledger transaction % does not balance for asset %: net %',
      NEW."transactionId", offending.asset_id, offending.net
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

-- ---------------------------------------------------------------------------
-- 4. An entry's asset must match the account it posts to. Prevents a USD leg
--    landing in a BTC account, which would balance arithmetically but be nonsense.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_assert_account_asset() RETURNS trigger AS $$
DECLARE
  account_asset TEXT;
BEGIN
  SELECT a."assetId" INTO account_asset
  FROM "ledger_accounts" a
  WHERE a."id" = NEW."accountId";

  IF account_asset IS NULL THEN
    RAISE EXCEPTION 'ledger entry references unknown account %', NEW."accountId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF account_asset <> NEW."assetId" THEN
    RAISE EXCEPTION
      'ledger entry asset % does not match account % asset %',
      NEW."assetId", NEW."accountId", account_asset
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_account_asset
  BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_account_asset();

-- ---------------------------------------------------------------------------
-- 5. Reconciliation support: recompute an account balance from entries alone.
--    This is the definition of "correct"; balance_projections is only a cache.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_account_balance(p_account_id TEXT)
RETURNS NUMERIC(38, 18) AS $$
  SELECT COALESCE(
    SUM(CASE WHEN e."direction" = 'DEBIT' THEN e."amount" ELSE -e."amount" END),
    0
  )::NUMERIC(38, 18)
  FROM "ledger_entries" e
  WHERE e."accountId" = p_account_id;
$$ LANGUAGE sql STABLE;
