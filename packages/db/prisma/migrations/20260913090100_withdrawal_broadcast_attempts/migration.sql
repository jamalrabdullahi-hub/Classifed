-- Broadcast bookkeeping, so an ambiguous send is visible rather than retried.
--
-- `broadcastAttempts` counts how many times a transfer has been attempted for a
-- withdrawal; a row that keeps coming back needs a person. `broadcastAt` ages a
-- BROADCASTING row so one stuck mid-flight can be found.
ALTER TABLE "withdrawals"
  ADD COLUMN "broadcastAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "broadcastAt" TIMESTAMP(3);
