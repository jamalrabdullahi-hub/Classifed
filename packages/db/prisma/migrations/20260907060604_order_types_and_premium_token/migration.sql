-- CreateEnum
CREATE TYPE "PerpOrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT', 'TAKE_PROFIT_MARKET', 'TAKE_PROFIT_LIMIT');

-- AlterTable
ALTER TABLE "perp_orders" ADD COLUMN     "bracketGroupId" TEXT,
ADD COLUMN     "orderType" "PerpOrderType" NOT NULL DEFAULT 'MARKET',
ADD COLUMN     "stopLossPrice" TEXT,
ADD COLUMN     "takeProfitPrice" TEXT,
ADD COLUMN     "triggerPrice" TEXT;

-- AlterTable
ALTER TABLE "protection_settings" ADD COLUMN     "premiumChainId" INTEGER,
ADD COLUMN     "premiumTokenAddress" TEXT;
