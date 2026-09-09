-- Registers BNB Smart Chain (a real EVM chain, wired into
-- packages/core/src/chains/registry.ts) and a reserved, non-EIP-155
-- identifier for Solana (used only so a Wallet row can hold a Solana
-- address — see SOLANA_CHAIN_ID in
-- packages/providers/src/wallet-provisioning/provision.ts for why this
-- number and not a real chain id). Neither row enables trading by itself;
-- see the comments at both source locations above.
--
-- The Solana id must fit in a signed 32-bit integer: "chains"."chainId" is
-- INTEGER, and the first version of this migration used 1151111081099710,
-- which fails with "integer out of range" (SQLSTATE 22003). Anything written
-- here has the same ceiling.
INSERT INTO "chains" ("chainId", "name", "shortName", "nativeSymbol", "nativeDecimals", "explorerUrl", "isEnabled", "createdAt", "updatedAt")
VALUES (56, 'BNB Smart Chain', 'bnb', 'BNB', 18, 'https://bscscan.com', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("chainId") DO NOTHING;

INSERT INTO "chains" ("chainId", "name", "shortName", "nativeSymbol", "nativeDecimals", "explorerUrl", "isEnabled", "createdAt", "updatedAt")
VALUES (1399811149, 'Solana', 'solana', 'SOL', 9, 'https://solscan.io', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("chainId") DO NOTHING;
