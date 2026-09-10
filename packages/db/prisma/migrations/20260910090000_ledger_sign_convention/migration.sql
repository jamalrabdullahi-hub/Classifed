-- Correct the ledger's non-negative constraint to respect account type.
--
-- The original CHECK required every account's balance to be >= 0, alongside
-- the rule that a transfer's entries sum to zero. Those two cannot both hold
-- for a deposit: receiving money increases an asset AND increases what is
-- owed, so in double entry one side is a debit and the other a credit, and
-- they carry opposite signs. A deposit was therefore unrepresentable — the
-- constraint would have rejected it.
--
-- The convention, stated once and relied on everywhere:
--
--   * An entry's amount is signed. Debits positive, credits negative.
--   * Asset accounts (what FLT holds) have a natural debit balance, so their
--     stored balance is >= 0.
--   * Liability accounts (what FLT owes) have a natural credit balance, so
--     their stored balance is <= 0. Reading code negates it for display —
--     see `naturalBalance` in services/ledger.ts.
--
-- The invariant that matters is unchanged and is the one worth keeping: a
-- client account can never be overdrawn, because an overdrawn client balance
-- is a balance FLT has promised twice.

ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_non_negative";

ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT "ledger_accounts_sign_by_kind" CHECK (
    "allowsNegative"
    OR ("kind" IN ('CLIENT_OMNIBUS', 'FIAT_GATEWAY') AND "balance" >= 0)
    OR ("kind" IN ('USER_AVAILABLE', 'USER_LOCKED', 'FEE_REVENUE') AND "balance" <= 0)
  );
