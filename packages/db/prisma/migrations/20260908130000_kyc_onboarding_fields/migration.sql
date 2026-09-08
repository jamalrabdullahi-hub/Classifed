-- CreateEnum
CREATE TYPE "KycRiskTier" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterTable
ALTER TABLE "kyc_profiles"
  ADD COLUMN "residenceAddress" TEXT,
  ADD COLUMN "occupation" TEXT,
  ADD COLUMN "accountPurpose" TEXT,
  ADD COLUMN "expectedMonthlyVolume" TEXT,
  ADD COLUMN "isPoliticallyExposed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pepDetails" TEXT,
  ADD COLUMN "riskTier" "KycRiskTier" NOT NULL DEFAULT 'LOW',
  ADD COLUMN "eddRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sourceOfFundsEvidence" TEXT;

-- CreateIndex
CREATE INDEX "kyc_profiles_riskTier_idx" ON "kyc_profiles"("riskTier");
