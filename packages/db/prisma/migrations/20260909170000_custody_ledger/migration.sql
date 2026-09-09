-- The custody ledger.
--
-- FLT holds client assets at a qualified sub-custodian and owes each client a
-- balance. Three invariants are enforced here rather than in application code,
-- because a rule that lives only in a service holds until somebody writes a
-- second service:
--
--   1. Every transfer's entries sum to exactly zero.
--   2. An account marked non-negative can never go below zero.
--   3. (kind, reference) is unique, so a retried deposit credits once.
--
-- Mt. Gox was drained for years because nobody compared an internal ledger to
-- the chain. FTX permitted a balance that could never be covered. Both are
-- ledger failures, and both are what these constraints exist to make
-- impossible rather than merely discouraged.

CREATE TYPE "LedgerAccountKind" AS ENUM (
  'USER_AVAILABLE',
  'USER_LOCKED',
  'CLIENT_OMNIBUS',
  'FEE_REVENUE',
  'FIAT_GATEWAY'
);

CREATE TYPE "LedgerTransferKind" AS ENUM (
  'DEPOSIT',
  'WITHDRAWAL',
  'TRADE_SETTLEMENT',
  'FEE',
  'LOCK',
  'UNLOCK',
  'ADJUSTMENT'
);

CREATE TABLE "ledger_accounts" (
  "id"             TEXT NOT NULL,
  "kind"           "LedgerAccountKind" NOT NULL,
  "userId"         TEXT,
  "asset"          TEXT NOT NULL,
  "balance"        DECIMAL(38,18) NOT NULL DEFAULT 0,
  "allowsNegative" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id"),
  -- Invariant 2. A client balance that can go negative is a balance FLT has
  -- promised twice.
  CONSTRAINT "ledger_accounts_non_negative"
    CHECK ("allowsNegative" OR "balance" >= 0)
);

CREATE UNIQUE INDEX "ledger_accounts_kind_userId_asset_key"
  ON "ledger_accounts" ("kind", "userId", "asset");
CREATE INDEX "ledger_accounts_userId_idx" ON "ledger_accounts" ("userId");

CREATE TABLE "ledger_transfers" (
  "id"               TEXT NOT NULL,
  "kind"             "LedgerTransferKind" NOT NULL,
  "reference"        TEXT,
  "memo"             TEXT NOT NULL,
  "createdByAdminId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ledger_transfers_pkey" PRIMARY KEY ("id")
);

-- Invariant 3. Idempotency for anything replayed: a custodian webhook, a
-- retried job, an operator clicking twice.
CREATE UNIQUE INDEX "ledger_transfers_kind_reference_key"
  ON "ledger_transfers" ("kind", "reference");
CREATE INDEX "ledger_transfers_createdAt_idx" ON "ledger_transfers" ("createdAt");

CREATE TABLE "ledger_entries" (
  "id"         TEXT NOT NULL,
  "transferId" TEXT NOT NULL,
  "accountId"  TEXT NOT NULL,
  "amount"     DECIMAL(38,18) NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id"),
  -- A zero-amount entry records nothing and only makes a transfer harder to
  -- read.
  CONSTRAINT "ledger_entries_non_zero" CHECK ("amount" <> 0)
);

CREATE INDEX "ledger_entries_accountId_createdAt_idx"
  ON "ledger_entries" ("accountId", "createdAt");
CREATE INDEX "ledger_entries_transferId_idx" ON "ledger_entries" ("transferId");

ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT "ledger_accounts_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: a ledger entry is a financial record. Deleting a user
-- must not silently delete evidence of money that moved.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_transferId_fkey"
  FOREIGN KEY ("transferId") REFERENCES "ledger_transfers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "ledger_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariant 1, as a deferred constraint trigger.
--
-- Deferred because the entries of one transfer are inserted as several
-- statements; the sum is only meaningful once the transaction is complete.
-- Checking per statement would reject every legitimate two-sided transfer.
CREATE OR REPLACE FUNCTION "ledger_transfer_balances"() RETURNS TRIGGER AS $$
DECLARE
  total DECIMAL(38,18);
  entry_count INTEGER;
BEGIN
  SELECT COALESCE(SUM("amount"), 0), COUNT(*)
    INTO total, entry_count
    FROM "ledger_entries"
   WHERE "transferId" = NEW."transferId";

  -- A transfer that was rolled back leaves no entries; nothing to check.
  IF entry_count = 0 THEN
    RETURN NULL;
  END IF;

  IF entry_count < 2 THEN
    RAISE EXCEPTION 'Ledger transfer % has % entry: a movement has two sides',
      NEW."transferId", entry_count;
  END IF;

  IF total <> 0 THEN
    RAISE EXCEPTION 'Ledger transfer % does not balance: entries sum to %',
      NEW."transferId", total;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ledger_entries_must_balance"
  AFTER INSERT OR UPDATE ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ledger_transfer_balances"();
