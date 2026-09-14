-- Trading is a separate application.
--
-- An account can exist, learn and hold a balance without being allowed to
-- trade. Placing trades requires approved identity verification *and* an
-- administrator's approval, recorded here with who gave it and when.
--
-- Accounts already verified before this change were trading under the old
-- rule, so they are approved now rather than cut off mid-position. Every
-- account verified from here on needs the explicit approval.
ALTER TABLE "users"
  ADD COLUMN "tradingApprovedAt" TIMESTAMP(3),
  ADD COLUMN "tradingApprovedById" TEXT;

UPDATE "users"
SET "tradingApprovedAt" = NOW()
WHERE "accountStatus" = 'KYC_APPROVED';
