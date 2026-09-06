-- AlterTable
ALTER TABLE "protection_policies" ADD COLUMN     "operatorAddress" TEXT,
ADD COLUMN     "operatorTxHash" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "poolAddress" TEXT,
ADD COLUMN     "poolTxHash" TEXT,
ADD COLUMN     "premiumChainId" INTEGER,
ADD COLUMN     "premiumContribution" TEXT,
ADD COLUMN     "premiumOperatorFee" TEXT,
ADD COLUMN     "premiumTokenAddress" TEXT,
ADD COLUMN     "premiumTotal" TEXT;
