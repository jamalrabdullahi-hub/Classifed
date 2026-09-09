-- UNVERIFIED tier, unlike every Base token row (checked on-chain against
-- scripts/verify-tokens.ts). Seeded only so the USD balance summary
-- (packages/core/src/services/portfolio-usd.ts) has stablecoin addresses to
-- read on BNB Chain — NOT an enablement of BNB spot trading, which stays
-- gated on "dex_providers"."supportedChainIds".
INSERT INTO "tokens" ("id", "chainId", "address", "symbol", "name", "decimals", "verificationTier", "isEnabled", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 56, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'USDC', 'USD Coin', 18, 'UNVERIFIED', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("chainId", "address") DO NOTHING;

INSERT INTO "tokens" ("id", "chainId", "address", "symbol", "name", "decimals", "verificationTier", "isEnabled", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 56, '0x55d398326f99059fF775485246999027B3197955', 'USDT', 'Tether USD', 18, 'UNVERIFIED', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("chainId", "address") DO NOTHING;
