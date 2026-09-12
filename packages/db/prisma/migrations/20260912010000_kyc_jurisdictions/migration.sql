-- Layered KYC (US + Somalia FGS): applicable regimes, nationality/phone, an
-- identity document stored as a hash + last four (never in the clear), and a
-- screening result. See services/kyc-jurisdiction.ts.
ALTER TABLE "kyc_profiles" ADD COLUMN "jurisdictions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "kyc_profiles" ADD COLUMN "nationalityCode" TEXT;
ALTER TABLE "kyc_profiles" ADD COLUMN "phone" TEXT;
ALTER TABLE "kyc_profiles" ADD COLUMN "idType" TEXT;
ALTER TABLE "kyc_profiles" ADD COLUMN "idCountry" TEXT;
ALTER TABLE "kyc_profiles" ADD COLUMN "idNumberHash" TEXT;
ALTER TABLE "kyc_profiles" ADD COLUMN "idNumberLast4" TEXT;
ALTER TABLE "kyc_profiles" ADD COLUMN "screeningStatus" TEXT;
ALTER TABLE "kyc_profiles" ADD COLUMN "screeningReason" TEXT;
