-- Withdrawals: taking funds out of custody.
--
-- The request locks the amount on the ledger so the same balance cannot back a
-- trade and a withdrawal at once. The debit happens only once the omnibus
-- transfer is confirmed in a mined receipt — a broadcast can revert or be
-- dropped, and debiting on the strength of having sent it would book money as
-- gone that never left.

CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'SENT', 'COMPLETED', 'FAILED');

CREATE TABLE "withdrawals" (
  "id"                TEXT NOT NULL,
  "userId"            TEXT NOT NULL,
  "asset"             TEXT NOT NULL,
  "chainId"           INTEGER NOT NULL,
  "decimals"          INTEGER NOT NULL,
  "amountBaseUnits"   TEXT NOT NULL,
  "destinationAddress" TEXT NOT NULL,
  "txHash"            TEXT,
  "status"            "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
  "failureReason"     TEXT,
  "sentAt"            TIMESTAMP(3),
  "completedAt"       TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id"),
  -- Base units are digits only and non-zero: a withdrawal of nothing is a bug.
  CONSTRAINT "withdrawals_amount"
    CHECK ("amountBaseUnits" ~ '^[0-9]+$' AND "amountBaseUnits" <> '0')
);

CREATE INDEX "withdrawals_status_createdAt_idx" ON "withdrawals" ("status", "createdAt");
CREATE INDEX "withdrawals_userId_createdAt_idx" ON "withdrawals" ("userId", "createdAt");

ALTER TABLE "withdrawals"
  ADD CONSTRAINT "withdrawals_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "withdrawals"
  ADD CONSTRAINT "withdrawals_chainId_fkey"
  FOREIGN KEY ("chainId") REFERENCES "chains" ("chainId") ON DELETE RESTRICT ON UPDATE CASCADE;
