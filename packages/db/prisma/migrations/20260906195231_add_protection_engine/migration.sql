-- CreateEnum
CREATE TYPE "ProtectionPolicyKind" AS ENUM ('BASE_DAY', 'BASE_SMOOTH', 'OMNI');

-- CreateEnum
CREATE TYPE "ProtectionState" AS ENUM ('CREATED', 'ACTIVE', 'WARNING', 'PROTECTION_ACTIVE', 'REBALANCE_REQUIRED', 'POSITION_REDUCTION', 'LIQUIDATED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProtectionLedgerKind" AS ENUM ('CONTRIBUTION', 'RELEASE', 'UTILIZATION', 'OPERATOR_FEE', 'EXECUTION_FEE', 'REALIZED_PNL');

-- CreateTable
CREATE TABLE "protection_policies" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "venueSlug" TEXT NOT NULL,
    "kind" "ProtectionPolicyKind" NOT NULL,
    "state" "ProtectionState" NOT NULL DEFAULT 'CREATED',
    "side" "PerpSide" NOT NULL,
    "entryPrice" TEXT NOT NULL,
    "referencePrice" TEXT NOT NULL,
    "notional" TEXT NOT NULL,
    "initialNotional" TEXT NOT NULL,
    "percentile" TEXT NOT NULL,
    "horizonDays" TEXT NOT NULL,
    "smoothStartAt" TEXT,
    "volatilityModel" TEXT NOT NULL,
    "volatilityInterval" TEXT NOT NULL,
    "volatilityWindow" INTEGER NOT NULL,
    "lastZScore" TEXT,
    "lastVolatility" TEXT,
    "lastStatisticalMove" TEXT,
    "lastBoundary" TEXT,
    "lastRequiredContribution" TEXT,
    "declaredContribution" TEXT NOT NULL DEFAULT '0',
    "calculatedAt" TIMESTAMP(3),
    "nextRebaseAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "protection_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protection_events" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "fromState" "ProtectionState" NOT NULL,
    "toState" "ProtectionState" NOT NULL,
    "underlyingPrice" TEXT NOT NULL,
    "markPrice" TEXT,
    "volatility" TEXT NOT NULL,
    "volatilityModel" TEXT NOT NULL,
    "percentile" TEXT NOT NULL,
    "zScore" TEXT NOT NULL,
    "zConvention" TEXT NOT NULL,
    "horizonDays" TEXT NOT NULL,
    "boundary" TEXT NOT NULL,
    "requiredContribution" TEXT NOT NULL,
    "currentContribution" TEXT NOT NULL,
    "positionSize" TEXT NOT NULL,
    "notional" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "executionPrice" TEXT,
    "fee" TEXT,
    "remainingProtectionBalance" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protection_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protection_ledger_entries" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "kind" "ProtectionLedgerKind" NOT NULL,
    "amount" TEXT NOT NULL,
    "balanceAfter" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "eventId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protection_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "protection_policies_userId_state_idx" ON "protection_policies"("userId", "state");

-- CreateIndex
CREATE INDEX "protection_policies_walletId_marketId_idx" ON "protection_policies"("walletId", "marketId");

-- CreateIndex
CREATE INDEX "protection_policies_state_nextRebaseAt_idx" ON "protection_policies"("state", "nextRebaseAt");

-- CreateIndex
CREATE INDEX "protection_events_policyId_occurredAt_idx" ON "protection_events"("policyId", "occurredAt");

-- CreateIndex
CREATE INDEX "protection_ledger_entries_policyId_kind_occurredAt_idx" ON "protection_ledger_entries"("policyId", "kind", "occurredAt");

-- AddForeignKey
ALTER TABLE "protection_policies" ADD CONSTRAINT "protection_policies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_policies" ADD CONSTRAINT "protection_policies_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_policies" ADD CONSTRAINT "protection_policies_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "perp_markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_events" ADD CONSTRAINT "protection_events_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "protection_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_ledger_entries" ADD CONSTRAINT "protection_ledger_entries_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "protection_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
