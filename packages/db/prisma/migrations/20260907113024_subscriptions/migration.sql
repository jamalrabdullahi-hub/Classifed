-- CreateEnum
CREATE TYPE "SubscriptionTier" AS ENUM ('FREE', 'BASIC', 'PRO', 'ELITE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING_PAYMENT', 'ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "subscription_plans" (
    "tier" "SubscriptionTier" NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "priceUsd" TEXT NOT NULL,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "feeDiscountBps" INTEGER NOT NULL DEFAULT 0,
    "watchlistLimit" INTEGER,
    "priceAlertLimit" INTEGER,
    "historyDays" INTEGER,
    "advancedOrderTools" BOOLEAN NOT NULL DEFAULT false,
    "fullIndicators" BOOLEAN NOT NULL DEFAULT false,
    "advancedRiskAnalytics" BOOLEAN NOT NULL DEFAULT false,
    "advancedProtectionAnalytics" BOOLEAN NOT NULL DEFAULT false,
    "fundingAnalytics" BOOLEAN NOT NULL DEFAULT false,
    "advancedPnl" BOOLEAN NOT NULL DEFAULT false,
    "fullPnl" BOOLEAN NOT NULL DEFAULT false,
    "apiAccess" BOOLEAN NOT NULL DEFAULT false,
    "priorityData" BOOLEAN NOT NULL DEFAULT false,
    "prioritySupport" BOOLEAN NOT NULL DEFAULT false,
    "maxLeverage" INTEGER NOT NULL DEFAULT 2,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("tier")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" "SubscriptionTier" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "pricePaidUsd" TEXT,
    "tokenAddress" TEXT,
    "chainId" INTEGER,
    "txHash" TEXT,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subscriptions_userId_status_idx" ON "subscriptions"("userId", "status");

-- CreateIndex
CREATE INDEX "subscriptions_status_endsAt_idx" ON "subscriptions"("status", "endsAt");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tier_fkey" FOREIGN KEY ("tier") REFERENCES "subscription_plans"("tier") ON DELETE RESTRICT ON UPDATE CASCADE;
