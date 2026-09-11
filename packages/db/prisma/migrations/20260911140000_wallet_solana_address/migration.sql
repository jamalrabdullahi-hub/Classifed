-- Let the Solana wallet row hold a base58 pubkey, not an EVM address.
--
-- `wallets_address_wellformed` (20260905190000_invariants) required every
-- wallet address to match '^0x[0-9a-f]{40}$' — EVM only. But provisioning also
-- stores one Solana wallet per participant (chainId 1399811149, the reserved
-- id in packages/providers/src/wallet-provisioning/provision.ts), and a Solana
-- address is base58, never hex. So every provisioning attempt inserted its Base
-- and BNB rows and then failed on the Solana row, rolling the whole transaction
-- back: the FLT rows were never written even though the Privy wallets had
-- already been created. Those are the orphaned wallets, and the write-once
-- `external_id` refusals that followed them — the "Something went wrong" on
-- /boorso "Create FLT wallet".
--
-- Chain-aware, not merely permissive: an EVM chain id still demands an EVM
-- address; only the reserved Solana id takes a base58 pubkey.
ALTER TABLE "wallets" DROP CONSTRAINT "wallets_address_wellformed";

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_address_wellformed" CHECK (
    ("chainId" = 1399811149 AND "address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
    OR ("chainId" <> 1399811149 AND "address" ~* '^0x[0-9a-f]{40}$')
  );
