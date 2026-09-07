-- CreateEnum
CREATE TYPE "ReferralEarningKind" AS ENUM ('SUBSCRIPTION', 'TRADING_FEE');

-- CreateEnum
CREATE TYPE "ReferralEarningStatus" AS ENUM ('ACCRUED', 'PAID', 'VOIDED');

-- CreateTable
CREATE TABLE "referral_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "grantedSubscriptionId" TEXT,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_earnings" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "kind" "ReferralEarningKind" NOT NULL,
    "status" "ReferralEarningStatus" NOT NULL DEFAULT 'ACCRUED',
    "grossAmount" TEXT NOT NULL,
    "shareBps" INTEGER NOT NULL,
    "amount" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "chainId" INTEGER,
    "currency" TEXT,
    "subscriptionId" TEXT,
    "quoteId" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidTxHash" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_userId_key" ON "referral_codes"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referredUserId_key" ON "referrals"("referredUserId");

-- CreateIndex
CREATE INDEX "referrals_referrerUserId_idx" ON "referrals"("referrerUserId");

-- CreateIndex
CREATE INDEX "referral_earnings_referrerUserId_status_idx" ON "referral_earnings"("referrerUserId", "status");

-- CreateIndex
CREATE INDEX "referral_earnings_status_idx" ON "referral_earnings"("status");

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "referral_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_earnings" ADD CONSTRAINT "referral_earnings_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_earnings" ADD CONSTRAINT "referral_earnings_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
