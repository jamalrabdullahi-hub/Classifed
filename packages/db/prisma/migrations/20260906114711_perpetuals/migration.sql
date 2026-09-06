-- CreateEnum
CREATE TYPE "PerpSide" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "PerpMarginMode" AS ENUM ('ISOLATED', 'CROSS');

-- CreateEnum
CREATE TYPE "PerpOrderStatus" AS ENUM ('PREPARED', 'SUBMITTED', 'FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "PerpOrderKind" AS ENUM ('OPEN', 'CLOSE', 'LEVERAGE_CHANGE');

-- CreateTable
CREATE TABLE "perp_markets" (
    "id" TEXT NOT NULL,
    "venueSlug" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "venueAssetId" INTEGER NOT NULL,
    "venueMaxLeverage" INTEGER NOT NULL,
    "maxLeverage" INTEGER NOT NULL,
    "sizeDecimals" INTEGER NOT NULL,
    "minSize" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "disabledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "perp_markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "perp_orders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "venueSlug" TEXT NOT NULL,
    "kind" "PerpOrderKind" NOT NULL DEFAULT 'OPEN',
    "status" "PerpOrderStatus" NOT NULL DEFAULT 'PREPARED',
    "side" "PerpSide" NOT NULL,
    "size" TEXT NOT NULL,
    "leverage" INTEGER NOT NULL,
    "marginMode" "PerpMarginMode" NOT NULL DEFAULT 'ISOLATED',
    "limitPrice" TEXT NOT NULL,
    "isMarketOrder" BOOLEAN NOT NULL DEFAULT true,
    "slippageBps" INTEGER NOT NULL,
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "referencePrice" TEXT,
    "estimatedLiquidationPrice" TEXT,
    "marginRequired" TEXT,
    "feeBps" INTEGER NOT NULL DEFAULT 0,
    "feeRecipient" TEXT,
    "feeConfigId" TEXT,
    "venueOrderId" TEXT,
    "filledSize" TEXT,
    "averageFillPrice" TEXT,
    "discrepancy" TEXT,
    "rejectionReason" TEXT,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "perp_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "perp_position_snapshots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "venueSlug" TEXT NOT NULL,
    "side" "PerpSide" NOT NULL,
    "size" TEXT NOT NULL,
    "entryPrice" TEXT NOT NULL,
    "margin" TEXT NOT NULL,
    "marginMode" "PerpMarginMode" NOT NULL DEFAULT 'ISOLATED',
    "leverage" INTEGER NOT NULL,
    "liquidationPrice" TEXT,
    "markPrice" TEXT,
    "unrealizedPnl" TEXT,
    "fundingPaid" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "perp_position_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "perp_markets_venueSlug_isEnabled_idx" ON "perp_markets"("venueSlug", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "perp_markets_venueSlug_symbol_key" ON "perp_markets"("venueSlug", "symbol");

-- CreateIndex
CREATE INDEX "perp_orders_userId_preparedAt_idx" ON "perp_orders"("userId", "preparedAt");

-- CreateIndex
CREATE INDEX "perp_orders_status_preparedAt_idx" ON "perp_orders"("status", "preparedAt");

-- CreateIndex
CREATE INDEX "perp_orders_venueSlug_venueOrderId_idx" ON "perp_orders"("venueSlug", "venueOrderId");

-- CreateIndex
CREATE INDEX "perp_position_snapshots_userId_idx" ON "perp_position_snapshots"("userId");

-- CreateIndex
CREATE INDEX "perp_position_snapshots_capturedAt_idx" ON "perp_position_snapshots"("capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "perp_position_snapshots_walletId_marketId_key" ON "perp_position_snapshots"("walletId", "marketId");

-- AddForeignKey
ALTER TABLE "perp_orders" ADD CONSTRAINT "perp_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perp_orders" ADD CONSTRAINT "perp_orders_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perp_orders" ADD CONSTRAINT "perp_orders_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "perp_markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perp_position_snapshots" ADD CONSTRAINT "perp_position_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perp_position_snapshots" ADD CONSTRAINT "perp_position_snapshots_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perp_position_snapshots" ADD CONSTRAINT "perp_position_snapshots_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "perp_markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
