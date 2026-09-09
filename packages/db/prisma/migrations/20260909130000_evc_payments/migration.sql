-- EVC Plus (mobile money) subscription payments.
--
-- A claim, not a settled payment: EVC Plus exposes no merchant API to FLT, so
-- a row here records what a participant says they paid and grants nothing
-- until an operator confirms it against the merchant statement.

CREATE TYPE "EvcPaymentStatus" AS ENUM ('AWAITING_REVIEW', 'CONFIRMED', 'REJECTED');

CREATE TABLE "evc_payments" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "tier"           "SubscriptionTier" NOT NULL,
  "days"           INTEGER NOT NULL,
  "amountUsd"      TEXT NOT NULL,
  "payerName"      TEXT NOT NULL,
  "payerPhone"     TEXT NOT NULL,
  "merchantNumber" TEXT NOT NULL,
  "status"         "EvcPaymentStatus" NOT NULL DEFAULT 'AWAITING_REVIEW',
  "subscriptionId" TEXT,
  "reviewedAt"     TIMESTAMP(3),
  "reviewedById"   TEXT,
  "reviewNote"     TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "evc_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "evc_payments_status_createdAt_idx" ON "evc_payments" ("status", "createdAt");
CREATE INDEX "evc_payments_userId_createdAt_idx" ON "evc_payments" ("userId", "createdAt");

ALTER TABLE "evc_payments"
  ADD CONSTRAINT "evc_payments_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "evc_payments"
  ADD CONSTRAINT "evc_payments_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "admin_users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
