-- The provider's own id for a wallet it manages.
--
-- Provisioning stored only the address, which is enough to display a balance
-- and not enough to sign: Privy's signing API addresses a wallet by its id.
-- Without this column an embedded wallet can hold funds and never move them.
--
-- Nullable, and null for every wallet a participant linked themselves — an
-- address is genuinely all there is to know about a MetaMask account.
ALTER TABLE "wallets" ADD COLUMN "providerWalletId" TEXT;
