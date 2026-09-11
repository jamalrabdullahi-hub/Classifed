-- Registers Base (8453) — the chain every FLT wallet is created against.
--
-- Base has always existed in the registry, but only via `prisma/seed.ts`. When
-- the BNB (56) and Solana (1399811149) rows were moved into a migration
-- (20260909100000_bnb_solana_chains) so that `prisma migrate deploy` alone
-- produced a usable registry, Base was left behind in the seed.
--
-- That omission is the "Create FLT wallet → Something went wrong" bug. An
-- environment that ran migrations but not the seed (the deploy script does not
-- run `db:seed`) has no Base row; `provisionWalletsOnDemand` then inserts a
-- Wallet row for chainId 8453 first, which fails the `wallets_chainId_fkey`
-- foreign key. A Prisma foreign-key error is not a `DomainError`, so the API
-- renders it as the generic 500 "Something went wrong" — with the real cause
-- only in the server log.
--
-- `ON CONFLICT DO NOTHING` keeps this a no-op on environments already seeded
-- (or re-seeded), matching the BNB/Solana migration.
INSERT INTO "chains" ("chainId", "name", "shortName", "nativeSymbol", "nativeDecimals", "explorerUrl", "isEnabled", "createdAt", "updatedAt")
VALUES (8453, 'Base', 'base', 'ETH', 18, 'https://basescan.org', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("chainId") DO NOTHING;
