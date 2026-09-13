-- Participant-authored offerings: creation, publishing, and a creator revenue
-- share; plus composable/custom Algo strategies.
--
-- `visibility` separates FLT's offerings (FLT) from a participant's own
-- (PRIVATE), a shared one (PUBLIC), and one awaiting review (PENDING_REVIEW).
-- `revenueShareBps` is the creator's cut of the management fee a PUBLIC
-- offering generates. `strategyType`/`composition`/`expression` let an Algo be a
-- built-in, a vote over several (COMPOSITE), or a restricted-language expression
-- (CUSTOM). `creator_earnings` records each split, deduped on the settlement ref.

CREATE TYPE "AlgorithmVisibility" AS ENUM ('FLT', 'PRIVATE', 'PUBLIC', 'PENDING_REVIEW');
CREATE TYPE "AlgorithmStrategyType" AS ENUM ('BUILTIN', 'COMPOSITE', 'CUSTOM');

ALTER TABLE "trading_algorithms"
  ADD COLUMN "visibility"      "AlgorithmVisibility" NOT NULL DEFAULT 'FLT',
  ADD COLUMN "revenueShareBps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "strategyType"    "AlgorithmStrategyType" NOT NULL DEFAULT 'BUILTIN',
  ADD COLUMN "composition"     JSONB,
  ADD COLUMN "expression"      TEXT,
  ADD COLUMN "creatorId"       TEXT;

ALTER TABLE "trading_algorithms"
  ADD CONSTRAINT "trading_algorithms_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_algorithms"
  ADD COLUMN "creatorEarningsUsd" NUMERIC(18, 8) NOT NULL DEFAULT 0;

CREATE TABLE "creator_earnings" (
  "id"               TEXT NOT NULL,
  "creatorId"        TEXT NOT NULL,
  "algorithmId"      TEXT NOT NULL,
  "subscriberUserId" TEXT NOT NULL,
  "settlementRef"    TEXT NOT NULL,
  "amountUsd"        NUMERIC(18, 8) NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "creator_earnings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creator_earnings_settlementRef_key"
  ON "creator_earnings" ("settlementRef");
CREATE INDEX "creator_earnings_creatorId_createdAt_idx"
  ON "creator_earnings" ("creatorId", "createdAt");
