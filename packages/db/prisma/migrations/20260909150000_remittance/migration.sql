-- Crypto-to-fiat remittance: stablecoin in, EVC Plus payout out.
--
-- The one place on this platform where FLT holds a participant's money. The
-- window between AWAITING_PAYOUT and PAID is a liability, which is why it is
-- an explicit status rather than an implicit gap: "what do we owe, and to
-- whom" must be answerable with one query.
--
-- Originator and beneficiary are stored as columns rather than derived at
-- report time. FATF R.16 requires them to travel with the transfer, and a
-- report has to say who the parties were then, not who they are now.

CREATE TYPE "RemittanceStatus" AS ENUM (
  'AWAITING_TRANSFER',
  'AWAITING_PAYOUT',
  'PAID',
  'REJECTED',
  'CANCELLED'
);

CREATE TABLE "remittance_orders" (
  "id"                      TEXT NOT NULL,
  "userId"                  TEXT NOT NULL,
  "status"                  "RemittanceStatus" NOT NULL DEFAULT 'AWAITING_TRANSFER',
  "tokenAddress"            TEXT NOT NULL,
  "chainId"                 INTEGER NOT NULL,
  "sendAmount"              TEXT NOT NULL,
  "sendAmountUsd"           TEXT NOT NULL,
  "originatorWallet"        TEXT NOT NULL,
  "originatorName"          TEXT NOT NULL,
  "txHash"                  TEXT,
  "verifiedAt"              TIMESTAMP(3),
  "beneficiaryName"         TEXT NOT NULL,
  "beneficiaryPhone"        TEXT NOT NULL,
  "beneficiaryRelationship" TEXT NOT NULL,
  "purpose"                 TEXT NOT NULL,
  "fxRate"                  TEXT NOT NULL,
  "feeUsd"                  TEXT NOT NULL,
  "payoutAmount"            TEXT NOT NULL,
  "payoutCurrency"          TEXT NOT NULL,
  "payoutReference"         TEXT,
  "paidAt"                  TIMESTAMP(3),
  "paidByAdminId"           TEXT,
  "reviewNote"              TEXT,
  "heldAt"                  TIMESTAMP(3),
  "heldReason"              TEXT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  "expiresAt"               TIMESTAMP(3) NOT NULL,

  CONSTRAINT "remittance_orders_pkey" PRIMARY KEY ("id")
);

-- One transaction can settle exactly one remittance. Without this a single
-- transfer could be submitted against several orders and be paid out more
-- than once.
CREATE UNIQUE INDEX "remittance_orders_txHash_key" ON "remittance_orders" ("txHash");
CREATE INDEX "remittance_orders_status_createdAt_idx" ON "remittance_orders" ("status", "createdAt");
CREATE INDEX "remittance_orders_userId_createdAt_idx" ON "remittance_orders" ("userId", "createdAt");

ALTER TABLE "remittance_orders"
  ADD CONSTRAINT "remittance_orders_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "remittance_orders"
  ADD CONSTRAINT "remittance_orders_paidByAdminId_fkey"
  FOREIGN KEY ("paidByAdminId") REFERENCES "admin_users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
