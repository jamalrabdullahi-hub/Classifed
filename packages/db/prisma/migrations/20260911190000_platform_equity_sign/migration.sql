-- Extend the ledger sign CHECK so PLATFORM_EQUITY is a liability-side
-- account: stored <= 0, like the client balances and FEE_REVENUE. Without a
-- branch for the kind it matches no clause and every row is rejected.

ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_sign_by_kind";

ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT "ledger_accounts_sign_by_kind" CHECK (
    "allowsNegative"
    OR ("kind" IN ('CLIENT_OMNIBUS', 'FIAT_GATEWAY', 'VENUE_MARGIN') AND "balance" >= 0)
    OR ("kind" IN ('USER_AVAILABLE', 'USER_LOCKED', 'FEE_REVENUE', 'PLATFORM_EQUITY') AND "balance" <= 0)
  );
