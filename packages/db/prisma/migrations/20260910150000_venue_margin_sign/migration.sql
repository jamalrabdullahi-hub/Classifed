-- Extend the ledger sign CHECK so VENUE_MARGIN is recognised as an asset
-- (stored >= 0), like CLIENT_OMNIBUS and FIAT_GATEWAY.
--
-- Without this branch the account would match no clause and every row would be
-- rejected — the CHECK falls through to false for an unrecognised kind.

ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_sign_by_kind";

ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT "ledger_accounts_sign_by_kind" CHECK (
    "allowsNegative"
    OR ("kind" IN ('CLIENT_OMNIBUS', 'FIAT_GATEWAY', 'VENUE_MARGIN') AND "balance" >= 0)
    OR ("kind" IN ('USER_AVAILABLE', 'USER_LOCKED', 'FEE_REVENUE') AND "balance" <= 0)
  );
