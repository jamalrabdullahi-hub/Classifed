-- Add the PLATFORM_EQUITY ledger account kind (FLT's own capital).
--
-- ADR 0006 (P8) names this account: it holds the residual between what the
-- platform holds (the omnibus and the venue) and what it owes clients, so a
-- shortfall is never socialized across client balances. Stored <= 0, like the
-- other liability-side kinds.
--
-- Split from the CHECK change in the next migration on purpose: Postgres
-- cannot USE a newly added enum value in the same transaction that adds it.
-- See 20260910140000_venue_margin_enum for the same pattern.

ALTER TYPE "LedgerAccountKind" ADD VALUE 'PLATFORM_EQUITY';
