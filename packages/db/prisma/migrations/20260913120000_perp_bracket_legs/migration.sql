-- Protective legs attached to an already-open position.
--
-- The venue ids live on the entry order, not as PerpOrder rows of their own.
-- Attribution reads the latest order per market and reads CLOSE as flat, so a
-- resting reduce-only leg recorded as its own CLOSE row would make an open
-- position look closed to the close path and to the runner.
ALTER TABLE "perp_orders"
  ADD COLUMN "takeProfitVenueOrderId" TEXT,
  ADD COLUMN "stopLossVenueOrderId" TEXT,
  ADD COLUMN "bracketUpdatedAt" TIMESTAMP(3);
