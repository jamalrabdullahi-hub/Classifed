-- Two automated offerings (Algo / AI) with a frictionless monthly management
-- fee, replacing the flat per-algorithm purchase price.
--
-- No entry cost: activation records the participant's allocated capital (the fee
-- base) and starts a daily accrual of 2%/month, pro-rated at 2%/31 per day. The
-- fee is charged on exit, and monthly while running. `priceUsd` (the old flat
-- price) and the one-time `pricePaidUsd`/`ledgerReference` are dropped — there
-- are no purchase rows to preserve and the charge is now a fee, not a purchase.

CREATE TYPE "AlgorithmKind" AS ENUM ('ALGO', 'AI');

ALTER TABLE "trading_algorithms"
  ADD COLUMN "kind"            "AlgorithmKind" NOT NULL DEFAULT 'ALGO',
  ADD COLUMN "managementFeeBps" INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN "requiresPro"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "systemPrompt"    TEXT,
  ADD COLUMN "promptRails"     JSONB NOT NULL DEFAULT '[]',
  ALTER COLUMN "periodDays" SET DEFAULT 31,
  DROP COLUMN "priceUsd";

ALTER TABLE "user_algorithms"
  ADD COLUMN "capitalBase"   TEXT NOT NULL DEFAULT '',
  ADD COLUMN "accruedFeeUsd" NUMERIC(18, 8) NOT NULL DEFAULT 0,
  ADD COLUMN "feeAccruedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "strategyParams" JSONB,
  ADD COLUMN "prompt"         TEXT,
  DROP COLUMN "pricePaidUsd",
  DROP COLUMN "ledgerReference";
