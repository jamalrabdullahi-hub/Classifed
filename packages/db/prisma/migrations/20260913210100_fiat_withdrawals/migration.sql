-- Cash withdrawals: USD paid out by an operator to an EVC number, a bank
-- account, or a PayPal address.
--
-- The participant's USDC is reserved on the ledger when they ask, and the
-- reservation is spent only when an operator records the payout with its
-- reference. A card payout needs a payment processor and is deliberately not a
-- method here.
CREATE TYPE "FiatWithdrawalMethod" AS ENUM ('EVC', 'BANK', 'PAYPAL');
CREATE TYPE "FiatWithdrawalStatus" AS ENUM ('REQUESTED', 'PAID', 'REJECTED');

-- The PayPal address a deposit is coming from, for matching it to the payment.
ALTER TABLE "fiat_deposits" ADD COLUMN "payerEmail" TEXT;

CREATE TABLE "fiat_withdrawals" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "method" "FiatWithdrawalMethod" NOT NULL,
  "asset" TEXT NOT NULL DEFAULT 'USDC',
  "amountUsd" DECIMAL(38,18) NOT NULL,
  "feeUsd" DECIMAL(38,18) NOT NULL,
  "netUsd" DECIMAL(38,18) NOT NULL,
  "payeeName" TEXT NOT NULL,
  "payeePhone" TEXT,
  "payeeEmail" TEXT,
  "bankName" TEXT,
  "accountNumber" TEXT,
  "routingNumber" TEXT,
  "swift" TEXT,
  "country" TEXT,
  "reference" TEXT NOT NULL,
  "status" "FiatWithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
  "payoutReference" TEXT,
  "note" TEXT,
  "paidAt" TIMESTAMP(3),
  "paidById" TEXT,
  "rejectedAt" TIMESTAMP(3),
  "rejectedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "fiat_withdrawals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fiat_withdrawals_reference_key" ON "fiat_withdrawals"("reference");
CREATE INDEX "fiat_withdrawals_status_createdAt_idx" ON "fiat_withdrawals"("status", "createdAt");
CREATE INDEX "fiat_withdrawals_userId_createdAt_idx" ON "fiat_withdrawals"("userId", "createdAt");

ALTER TABLE "fiat_withdrawals"
  ADD CONSTRAINT "fiat_withdrawals_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
