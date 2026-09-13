-- Account deletion requests.
--
-- Google Play requires that people can ask for their account to be deleted.
-- On a custodial exchange that is a request, not an instant erase: the holder
-- must first have nothing held, and transaction and identity-verification
-- records are retained as the law requires. The account is suspended the moment
-- the request is made, and an operator completes it by anonymising personal
-- details. The previous status is kept so a refused request can be undone.
CREATE TYPE "AccountDeletionStatus" AS ENUM ('REQUESTED', 'COMPLETED', 'REFUSED');

CREATE TABLE "account_deletion_requests" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "AccountDeletionStatus" NOT NULL DEFAULT 'REQUESTED',
  "previousAccountStatus" "AccountStatus" NOT NULL,
  "previousTradingDisabled" BOOLEAN NOT NULL,
  "note" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "completedById" TEXT,
  "refusedAt" TIMESTAMP(3),
  "refusedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "account_deletion_requests_status_requestedAt_idx" ON "account_deletion_requests"("status", "requestedAt");
CREATE INDEX "account_deletion_requests_userId_idx" ON "account_deletion_requests"("userId");

ALTER TABLE "account_deletion_requests"
  ADD CONSTRAINT "account_deletion_requests_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
