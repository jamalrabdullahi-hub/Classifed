-- Opens perpetuals to the free tier at its existing 2x ceiling.
--
-- `maxLeverage` for FREE is already 2 and is the real boundary; withholding
-- access on top of it made the free tier a brochure for a product nobody could
-- try. The cap still applies to every asset class the venues list — crypto,
-- stock mimics, futures, forex — because it is enforced per order, not per
-- class.
--
-- A data migration rather than a seed change alone: scripts/seed-plans.ts does
-- not run on deploy, so an existing row would otherwise keep the old value.
UPDATE "subscription_plans"
SET "perpsAccess" = true,
    "tagline"     = 'Trading at 2x, and the basics.'
WHERE "tier" = 'FREE';
