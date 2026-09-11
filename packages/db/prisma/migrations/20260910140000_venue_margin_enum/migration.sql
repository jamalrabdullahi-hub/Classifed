-- Add the VENUE_MARGIN ledger account kind (perpetual venue collateral).
--
-- Split from the CHECK change in the next migration on purpose: Postgres
-- cannot USE a newly added enum value in the same transaction that adds it,
-- and the CHECK below references it. See 20260910105000_deposit_sent_enum for
-- the same pattern.

ALTER TYPE "LedgerAccountKind" ADD VALUE 'VENUE_MARGIN';
