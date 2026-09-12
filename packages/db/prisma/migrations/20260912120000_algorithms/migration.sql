-- Trading algorithms: FLT-authored strategies a participant can buy and have
-- run automatically.
--
-- Two tables plus a run log. `trading_algorithms` is the catalog FLT sells;
-- `user_algorithms` is what one participant bought (the accounting fact — price
-- paid, ledger reference, period); `algorithm_runs` records each decision the
-- runner made, so "did the bot already act on this bar" survives a crash.
--
-- No money moves through these tables. Buying debits the participant's balance
-- on the custody ledger (USER_AVAILABLE -> FEE_REVENUE); the runner places perp
-- orders through the ordinary custody path, subject to the same insurance,
-- leverage, entitlement and balance checks as any manual trade.

CREATE TYPE "AlgorithmStatus" AS ENUM (
  'ACTIVE',
  'PAUSED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TYPE "AlgorithmStrategy" AS ENUM (
  'MA_CROSSOVER',
  'MEAN_REVERSION',
  'MOMENTUM'
);

CREATE TABLE "trading_algorithms" (
  "id"             TEXT NOT NULL,
  "slug"           TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "description"    TEXT NOT NULL,
  "strategy"       "AlgorithmStrategy" NOT NULL,
  "params"         JSONB NOT NULL DEFAULT '{}',
  "symbols"        TEXT[] NOT NULL,
  "maxLeverage"    INTEGER NOT NULL DEFAULT 1,
  "maxNotionalUsd" TEXT NOT NULL,
  "priceUsd"       TEXT NOT NULL,
  "periodDays"     INTEGER,
  "isActive"       BOOLEAN NOT NULL DEFAULT false,
  "isFeatured"     BOOLEAN NOT NULL DEFAULT false,
  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "trading_algorithms_pkey" PRIMARY KEY ("id"),
  -- A leverage under 1, a zero notional cap, or a malformed price is
  -- misconfiguration, not a fast algorithm. The caps are decimal strings, so
  -- the pattern is digits with at most a fractional part.
  CONSTRAINT "trading_algorithms_bounds"
    CHECK (
      "maxLeverage" >= 1
      AND "maxNotionalUsd" ~ '^[0-9]+(\.[0-9]+)?$'
      AND "maxNotionalUsd" <> '0'
      AND "priceUsd" ~ '^[0-9]+(\.[0-9]{1,2})?$'
    )
);

CREATE UNIQUE INDEX "trading_algorithms_slug_key" ON "trading_algorithms" ("slug");
CREATE INDEX "trading_algorithms_isActive_idx" ON "trading_algorithms" ("isActive");

CREATE TABLE "user_algorithms" (
  "id"              TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "algorithmId"     TEXT NOT NULL,
  "status"          "AlgorithmStatus" NOT NULL DEFAULT 'ACTIVE',
  "pricePaidUsd"    TEXT NOT NULL,
  "ledgerReference" TEXT NOT NULL,
  "startsAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt"          TIMESTAMP(3),
  "lastRunAt"       TIMESTAMP(3),
  "cancelledAt"     TIMESTAMP(3),
  "cancelReason"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_algorithms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_algorithms_userId_algorithmId_idx"
  ON "user_algorithms" ("userId", "algorithmId");
CREATE INDEX "user_algorithms_status_lastRunAt_idx"
  ON "user_algorithms" ("status", "lastRunAt");

ALTER TABLE "user_algorithms"
  ADD CONSTRAINT "user_algorithms_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_algorithms"
  ADD CONSTRAINT "user_algorithms_algorithmId_fkey"
  FOREIGN KEY ("algorithmId") REFERENCES "trading_algorithms" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "algorithm_runs" (
  "id"              TEXT NOT NULL,
  "userAlgorithmId" TEXT NOT NULL,
  "symbol"          TEXT NOT NULL,
  "side"            "PerpSide" NOT NULL,
  "signal"          TEXT NOT NULL,
  "perpOrderId"     TEXT,
  "status"          TEXT NOT NULL,
  "reason"          TEXT,
  "decidedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "algorithm_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "algorithm_runs_userAlgorithmId_decidedAt_idx"
  ON "algorithm_runs" ("userAlgorithmId", "decidedAt");

ALTER TABLE "algorithm_runs"
  ADD CONSTRAINT "algorithm_runs_userAlgorithmId_fkey"
  FOREIGN KEY ("userAlgorithmId") REFERENCES "user_algorithms" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
