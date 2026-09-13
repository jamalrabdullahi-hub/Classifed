-- Per-subscription settings and guardrails for automatic trading.
--
-- `settings` holds the participant's own leverage, market subset, trade size and
-- risk limits, always bounded by the offering. `pausedReason` records why the
-- runner paused a subscription itself when a guardrail tripped, so the
-- participant is told rather than finding it stopped.
ALTER TABLE "user_algorithms"
  ADD COLUMN "settings" JSONB,
  ADD COLUMN "pausedReason" TEXT;
