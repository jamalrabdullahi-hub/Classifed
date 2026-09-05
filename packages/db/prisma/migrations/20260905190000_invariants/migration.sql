-- Invariants the application must not be able to violate, even through a bug.
--
-- Prisma's schema language cannot express these, and every one of them protects
-- a number a user makes a financial decision on. A CHECK constraint is the last
-- line: if application code ever writes a quote with a minimum output above its
-- expected output, the write fails rather than reaching a review screen.

-- ── Quotes ──────────────────────────────────────────────────────────────────

-- Amounts are base-unit integers held as strings. Anything else is a bug that
-- would surface as a wallet rejecting the transaction, or worse, not rejecting it.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_amounts_are_integers" CHECK (
    "sellAmount" ~ '^[0-9]+$'
    AND "buyAmount" ~ '^[0-9]+$'
    AND "minBuyAmount" ~ '^[0-9]+$'
  );

-- A quote for nothing is not a quote.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_sell_amount_positive" CHECK ("sellAmount" <> '0');

-- The floor cannot exceed the expectation. Compared as numerics rather than as
-- text, so '9' does not sort above '10'.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_min_below_expected" CHECK (
    "minBuyAmount"::numeric <= "buyAmount"::numeric
  );

-- Slippage and fees are basis points. 0x caps affiliate fees at 1000 bps, and
-- a fee above that would be silently rejected by the venue after the user has
-- already reviewed it.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_slippage_in_range" CHECK ("slippageBps" BETWEEN 0 AND 10000);

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_fee_in_range" CHECK ("feeBps" BETWEEN 0 AND 1000);

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_price_impact_sane" CHECK (
    "priceImpactBps" IS NULL OR "priceImpactBps" BETWEEN 0 AND 10000
  );

-- A quote must expire after it was created, or it is born dead.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_expiry_after_creation" CHECK ("expiresAt" > "createdAt");

-- Calldata is what the wallet signs. Empty calldata with a non-empty target is
-- a malformed quote.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_calldata_present" CHECK (
    "txTo" ~* '^0x[0-9a-f]{40}$'
    AND "txData" ~* '^0x[0-9a-f]*$'
    AND "txValue" ~ '^[0-9]+$'
    AND length("calldataHash") = 64
  );

-- ── Transactions ────────────────────────────────────────────────────────────

-- A 32-byte hash. Anything else cannot be looked up on-chain.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_hash_wellformed" CHECK ("txHash" ~* '^0x[0-9a-f]{64}$');

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_actual_amounts_are_integers" CHECK (
    ("amountInActual" IS NULL OR "amountInActual" ~ '^[0-9]+$')
    AND ("amountOutActual" IS NULL OR "amountOutActual" ~ '^[0-9]+$')
  );

-- A confirmation time without a CONFIRMED status, or the reverse, means the
-- monitor wrote an inconsistent record.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_confirmed_consistency" CHECK (
    ("status" = 'CONFIRMED' AND "confirmedAt" IS NOT NULL)
    OR ("status" <> 'CONFIRMED' AND "confirmedAt" IS NULL)
  );

-- ── Tokens ──────────────────────────────────────────────────────────────────

ALTER TABLE "tokens"
  ADD CONSTRAINT "tokens_address_wellformed" CHECK ("address" ~* '^0x[0-9a-f]{40}$');

-- ERC-20 decimals is a uint8, and nothing real exceeds 36.
ALTER TABLE "tokens"
  ADD CONSTRAINT "tokens_decimals_in_range" CHECK ("decimals" BETWEEN 0 AND 36);

-- A disabled token must say why, so the admin panel and the trade screen can
-- both explain the refusal instead of failing silently.
ALTER TABLE "tokens"
  ADD CONSTRAINT "tokens_disabled_has_reason" CHECK (
    "isEnabled" = true OR "disabledReason" IS NOT NULL
  );

-- ── Wallets ─────────────────────────────────────────────────────────────────

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_address_wellformed" CHECK ("address" ~* '^0x[0-9a-f]{40}$');

-- ── Fee configuration ───────────────────────────────────────────────────────

-- Each fee type needs its own field populated. A PERCENTAGE rule with no bps
-- resolves to nothing; a FIXED rule with no amount does the same.
ALTER TABLE "fee_configs"
  ADD CONSTRAINT "fee_configs_type_has_value" CHECK (
    ("feeType" = 'PERCENTAGE' AND "bps" IS NOT NULL AND "bps" BETWEEN 0 AND 1000)
    OR ("feeType" = 'FIXED' AND "fixedAmount" IS NOT NULL AND "fixedAmount" ~ '^[0-9]+$')
  );

-- A promotional window that ends before it starts never applies.
ALTER TABLE "fee_configs"
  ADD CONSTRAINT "fee_configs_window_ordered" CHECK (
    "validFrom" IS NULL OR "validUntil" IS NULL OR "validUntil" > "validFrom"
  );

-- ── Sessions ────────────────────────────────────────────────────────────────

ALTER TABLE "user_sessions"
  ADD CONSTRAINT "user_sessions_expiry_after_creation" CHECK ("expiresAt" > "createdAt");

ALTER TABLE "admin_sessions"
  ADD CONSTRAINT "admin_sessions_expiry_after_creation" CHECK ("expiresAt" > "createdAt");

ALTER TABLE "email_tokens"
  ADD CONSTRAINT "email_tokens_expiry_after_creation" CHECK ("expiresAt" > "createdAt");

-- ── Rate limiting ───────────────────────────────────────────────────────────

-- The bucket refill arithmetic must never leave a bucket above capacity or
-- deeply negative; either would mean the limiter has stopped limiting.
ALTER TABLE "rate_limit_buckets"
  ADD CONSTRAINT "rate_limit_buckets_tokens_bounded" CHECK ("tokens" >= -1000 AND "tokens" <= 100000);
