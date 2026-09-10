-- Fiat deposits: cash in, crypto into the participant's own wallet.
--
-- Two statuses rather than a boolean, because there are two facts with a gap
-- between them. Between FUNDS_RECEIVED and DELIVERED, FLT is holding somebody's
-- money without having given them anything — a real liability, recorded in the
-- ledger. A single "done" flag would hide the exposure exactly while it exists.
--
-- Once delivered, the crypto is in a wallet whose key Privy holds and FLT does
-- not, so FLT owes nothing further and the balance on screen is the
-- participant's on-chain balance rather than a number in this table.

CREATE TYPE "FiatDepositMethod" AS ENUM ('ACH', 'WIRE', 'EVC', 'CASH');

CREATE TYPE "FiatDepositStatus" AS ENUM (
  'AWAITING_FUNDS',
  'FUNDS_RECEIVED',
  'DELIVERED',
  'REJECTED'
);

CREATE TABLE "fiat_deposits" (
  "id"              TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "method"          "FiatDepositMethod" NOT NULL,
  "currency"        TEXT NOT NULL DEFAULT 'USD',
  "amountFiat"      DECIMAL(38,18) NOT NULL,
  "amountReceived"  DECIMAL(38,18),
  "feeUsd"          DECIMAL(38,18),
  "netUsd"          DECIMAL(38,18),
  "reference"       TEXT NOT NULL,
  "bankReference"   TEXT,
  "status"          "FiatDepositStatus" NOT NULL DEFAULT 'AWAITING_FUNDS',
  "deliveryAddress" TEXT,
  "deliveryChainId" INTEGER,
  "deliveryTxHash"  TEXT,
  "deliveredAt"     TIMESTAMP(3),
  "receivedAt"      TIMESTAMP(3),
  "receivedById"    TEXT,
  "deliveredById"   TEXT,
  "note"            TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "fiat_deposits_pkey" PRIMARY KEY ("id"),
  -- A deposit for nothing is a mistake, not an intention.
  CONSTRAINT "fiat_deposits_positive" CHECK ("amountFiat" > 0)
);

-- The code the participant puts on their transfer. Unique because it is how an
-- operator matches a bank line to an account, and a collision would attribute
-- somebody's money to the wrong person.
CREATE UNIQUE INDEX "fiat_deposits_reference_key" ON "fiat_deposits" ("reference");
CREATE INDEX "fiat_deposits_status_createdAt_idx" ON "fiat_deposits" ("status", "createdAt");
CREATE INDEX "fiat_deposits_userId_createdAt_idx" ON "fiat_deposits" ("userId", "createdAt");

ALTER TABLE "fiat_deposits"
  ADD CONSTRAINT "fiat_deposits_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "fiat_deposits"
  ADD CONSTRAINT "fiat_deposits_receivedById_fkey"
  FOREIGN KEY ("receivedById") REFERENCES "admin_users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "fiat_deposits"
  ADD CONSTRAINT "fiat_deposits_deliveredById_fkey"
  FOREIGN KEY ("deliveredById") REFERENCES "admin_users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
