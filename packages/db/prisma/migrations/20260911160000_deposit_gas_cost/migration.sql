-- The network (gas) fee charged against a crypto deposit, and a sweep attempt
-- counter.
--
-- The sweep is a transaction *from* the participant's deposit address, which
-- holds only stablecoin, so the omnibus fronts the gas and the cost is
-- recovered from the deposit (capped at 1%). Recorded on the row so the amount
-- credited can be reconciled against the amount the chain delivered.
--
-- `attempts` bounds the retry of a failed sweep: a transient failure (an RPC
-- blip, a gas race) heals itself, and a permanent one stops rather than looping.
ALTER TABLE "custody_deposits"
  ADD COLUMN "gasCostBaseUnits" TEXT NOT NULL DEFAULT '0';

ALTER TABLE "custody_deposits"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
