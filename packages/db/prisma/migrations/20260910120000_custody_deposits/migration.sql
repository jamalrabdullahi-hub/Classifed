-- Crypto deposits into custody.
--
-- A participant sends USDC/USDT to their own FLT deposit address; a worker
-- detects it, sweeps it into the omnibus, and credits their ledger balance —
-- but only once the sweep is confirmed in a mined receipt. That gate is why
-- this table exists: without a record of "detected but not yet confirmed", a
-- worker would have to either credit on a broadcast (which can revert) or lose
-- the deposit across a restart.
--
-- (chainId, depositTxHash, logIndex) is one inbound transfer. Unique, so a
-- re-scan of the same block credits the same deposit once. The amount is kept
-- as a base-unit STRING: a uint256 fits no numeric type, and the amount is the
-- one value that must not lose precision.

CREATE TYPE "CustodyDepositStatus" AS ENUM (
  'DETECTED',
  'SWEEPING',
  'SWEPT',
  'CREDITED',
  'FAILED'
);

CREATE TABLE "custody_deposits" (
  "id"              TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "asset"           TEXT NOT NULL,
  "chainId"         INTEGER NOT NULL,
  "decimals"        INTEGER NOT NULL,
  "amountBaseUnits" TEXT NOT NULL,
  "depositAddress"  TEXT NOT NULL,
  "depositTxHash"   TEXT NOT NULL,
  "logIndex"        INTEGER NOT NULL,
  "sweepTxHash"     TEXT,
  "sweptAt"         TIMESTAMP(3),
  "ledgerReference" TEXT,
  "status"          "CustodyDepositStatus" NOT NULL DEFAULT 'DETECTED',
  "failureReason"   TEXT,
  "creditedAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "custody_deposits_pkey" PRIMARY KEY ("id"),
  -- A deposit of nothing, or of a non-integer, is a detection bug rather than a
  -- real transfer. The amount is base units, so it is digits only, and non-zero.
  CONSTRAINT "custody_deposits_amount"
    CHECK ("amountBaseUnits" ~ '^[0-9]+$' AND "amountBaseUnits" <> '0')
);

-- The detection identity: one inbound transfer. Re-scanning the same block must
-- not mint a second deposit for the same money. Named as Prisma names a
-- `@@unique([chainId, depositTxHash, logIndex])` so a later schema diff does not
-- read the hand-written index as drift.
CREATE UNIQUE INDEX "custody_deposits_chainId_depositTxHash_logIndex_key"
  ON "custody_deposits" ("chainId", "depositTxHash", "logIndex");
CREATE INDEX "custody_deposits_status_createdAt_idx"
  ON "custody_deposits" ("status", "createdAt");
CREATE INDEX "custody_deposits_userId_createdAt_idx"
  ON "custody_deposits" ("userId", "createdAt");

ALTER TABLE "custody_deposits"
  ADD CONSTRAINT "custody_deposits_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "custody_deposits"
  ADD CONSTRAINT "custody_deposits_chainId_fkey"
  FOREIGN KEY ("chainId") REFERENCES "chains" ("chainId") ON DELETE RESTRICT ON UPDATE CASCADE;
