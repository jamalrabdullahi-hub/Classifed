-- CreateEnum
CREATE TYPE "LiquidityTier" AS ENUM ('TIER_1', 'TIER_2', 'TIER_3', 'TIER_4');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('INSTANT', 'RFQ', 'MANUAL', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "ExecutionVenueKind" AS ENUM ('INVENTORY', 'DEX', 'OTC');

-- CreateEnum
CREATE TYPE "ExecutionAttemptStatus" AS ENUM ('QUOTED', 'REJECTED', 'SIMULATING', 'SUBMITTED', 'FILLED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SwapStatus" AS ENUM ('PENDING', 'SIMULATED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'REVERTED', 'DROPPED');

-- CreateEnum
CREATE TYPE "ProtocolKind" AS ENUM ('AGGREGATOR', 'AMM', 'RFQ', 'BRIDGE');

-- CreateEnum
CREATE TYPE "ScreeningRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'SEVERE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ScreeningDecision" AS ENUM ('ACCEPT', 'REVIEW', 'REJECT');

-- CreateEnum
CREATE TYPE "ScreeningSubject" AS ENUM ('ADDRESS', 'TRANSACTION');

-- CreateEnum
CREATE TYPE "WalletTier" AS ENUM ('HOT', 'WARM', 'COLD');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LedgerTransactionType" ADD VALUE 'TREASURY_SWAP';
ALTER TYPE "LedgerTransactionType" ADD VALUE 'TREASURY_OTC_FILL';
ALTER TYPE "LedgerTransactionType" ADD VALUE 'TREASURY_TRANSFER';
ALTER TYPE "LedgerTransactionType" ADD VALUE 'GAS_FEE';

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "chain" TEXT,
ADD COLUMN     "contractAddress" TEXT,
ADD COLUMN     "executionMode" "ExecutionMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "isNativeAsset" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "liquidityTier" "LiquidityTier" NOT NULL DEFAULT 'TIER_3',
ADD COLUMN     "maxDexTradeUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
ADD COLUMN     "maxPriceImpactBps" INTEGER NOT NULL DEFAULT 100;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "executionVenue" "ExecutionVenueKind",
ADD COLUMN     "minOutputAmount" DECIMAL(38,18),
ADD COLUMN     "priceImpactBps" INTEGER;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "indicativeVenue" "ExecutionVenueKind",
ADD COLUMN     "minOutputAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
ADD COLUMN     "priceImpactBps" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "protocols" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ProtocolKind" NOT NULL,
    "chain" TEXT NOT NULL,
    "routerAddress" TEXT,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "auditUrl" TEXT,
    "hasUpgradeableAdmin" BOOLEAN NOT NULL DEFAULT true,
    "exploitHistory" JSONB,
    "reviewNotes" TEXT,
    "maxTradeUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "protocols_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_wallets" (
    "id" TEXT NOT NULL,
    "tier" "WalletTier" NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "custodian" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "maxPerTxUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "maxDailyOutUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "manualApprovalAboveUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treasury_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_targets" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "targetUsd" DECIMAL(38,18) NOT NULL,
    "minUsd" DECIMAL(38,18) NOT NULL,
    "maxUsd" DECIMAL(38,18) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treasury_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_attempts" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "venueKind" "ExecutionVenueKind" NOT NULL,
    "venueName" TEXT NOT NULL,
    "protocolId" TEXT,
    "requestedAmount" DECIMAL(38,18) NOT NULL,
    "requestedAsset" TEXT NOT NULL,
    "quotedOutput" DECIMAL(38,18),
    "minOutput" DECIMAL(38,18),
    "actualOutput" DECIMAL(38,18),
    "priceImpactBps" INTEGER,
    "protocolFee" DECIMAL(38,18),
    "gasFeeNative" DECIMAL(38,18),
    "gasFeeUsd" DECIMAL(38,18),
    "netOutput" DECIMAL(38,18),
    "route" JSONB,
    "status" "ExecutionAttemptStatus" NOT NULL DEFAULT 'QUOTED',
    "failureReason" TEXT,
    "externalRef" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "execution_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swap_transactions" (
    "id" TEXT NOT NULL,
    "executionAttemptId" TEXT,
    "treasuryWalletId" TEXT,
    "protocolId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "fromSymbol" TEXT NOT NULL,
    "toSymbol" TEXT NOT NULL,
    "amountIn" DECIMAL(38,18) NOT NULL,
    "minAmountOut" DECIMAL(38,18) NOT NULL,
    "amountOut" DECIMAL(38,18),
    "txHash" TEXT,
    "blockNumber" INTEGER,
    "gasUsed" DECIMAL(38,18),
    "gasFeeNative" DECIMAL(38,18),
    "privateSubmission" BOOLEAN NOT NULL DEFAULT false,
    "status" "SwapStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "simulation" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "deadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "swap_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screening_results" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "subjectType" "ScreeningSubject" NOT NULL,
    "chain" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "risk" "ScreeningRisk" NOT NULL,
    "score" INTEGER,
    "categories" JSONB NOT NULL,
    "decision" "ScreeningDecision" NOT NULL,
    "rawResult" JSONB,
    "screenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "screening_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_approvals" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "valueUsd" DECIMAL(38,18),
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manual_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "protocols_slug_key" ON "protocols"("slug");

-- CreateIndex
CREATE INDEX "protocols_chain_isApproved_idx" ON "protocols"("chain", "isApproved");

-- CreateIndex
CREATE INDEX "treasury_wallets_tier_isActive_idx" ON "treasury_wallets"("tier", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "treasury_wallets_chain_address_key" ON "treasury_wallets"("chain", "address");

-- CreateIndex
CREATE UNIQUE INDEX "treasury_targets_assetId_key" ON "treasury_targets"("assetId");

-- CreateIndex
CREATE INDEX "execution_attempts_orderId_idx" ON "execution_attempts"("orderId");

-- CreateIndex
CREATE INDEX "execution_attempts_venueKind_status_idx" ON "execution_attempts"("venueKind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "execution_attempts_orderId_sequence_key" ON "execution_attempts"("orderId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "swap_transactions_executionAttemptId_key" ON "swap_transactions"("executionAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "swap_transactions_idempotencyKey_key" ON "swap_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "swap_transactions_status_idx" ON "swap_transactions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "swap_transactions_chain_txHash_key" ON "swap_transactions"("chain", "txHash");

-- CreateIndex
CREATE INDEX "screening_results_subject_subjectType_idx" ON "screening_results"("subject", "subjectType");

-- CreateIndex
CREATE INDEX "screening_results_decision_idx" ON "screening_results"("decision");

-- CreateIndex
CREATE INDEX "manual_approvals_status_idx" ON "manual_approvals"("status");

-- CreateIndex
CREATE UNIQUE INDEX "manual_approvals_entityType_entityId_key" ON "manual_approvals"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "assets_liquidityTier_idx" ON "assets"("liquidityTier");

-- AddForeignKey
ALTER TABLE "treasury_targets" ADD CONSTRAINT "treasury_targets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "protocols"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_transactions" ADD CONSTRAINT "swap_transactions_executionAttemptId_fkey" FOREIGN KEY ("executionAttemptId") REFERENCES "execution_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_transactions" ADD CONSTRAINT "swap_transactions_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "protocols"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_transactions" ADD CONSTRAINT "swap_transactions_treasuryWalletId_fkey" FOREIGN KEY ("treasuryWalletId") REFERENCES "treasury_wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
