/**
 * Adds a token to the registry, reading its identity from the chain.
 *
 * Tokens previously came only from the seed, so listing one meant editing
 * source and redeploying. This is the same shape as `sync-perp-markets.ts`:
 * resolve the facts from the authoritative source, write the row **disabled**,
 * and leave enabling to an operator in the admin panel.
 *
 * Symbol and decimals are read from the contract rather than taken as
 * arguments. A registry that displays a symbol somebody typed is a registry
 * that will eventually display the wrong one, and decimals typed wrongly
 * misprice every trade in that token by orders of magnitude.
 *
 *   pnpm add:token 0xTokenAddress "Optional Display Name"
 *
 * Verification tier is always UNVERIFIED. Reviewing a contract is a judgement,
 * not a side effect of inserting a row — and if listing is ever sold, that
 * separation is what stops a paid listing from looking like an endorsement.
 */

import { createPublicClient, erc20Abi, getAddress, http, isAddress } from 'viem';
import { base } from 'viem/chains';
import { prisma, TokenVerificationTier } from '@flt/db';
import { newId } from '@flt/core/domain';

const RPC_URL = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
const BASE_CHAIN_ID = 8453;

const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

async function main(): Promise<void> {
  const [rawAddress, displayName] = process.argv.slice(2);

  if (!rawAddress) {
    console.error('Usage: pnpm add:token <contract address> ["Display name"]');
    process.exit(1);
  }

  if (!isAddress(rawAddress)) {
    console.error(`Not a valid address: ${rawAddress}`);
    process.exit(1);
  }

  const address = getAddress(rawAddress);

  const existing = await prisma.token.findUnique({
    where: { chainId_address: { chainId: BASE_CHAIN_ID, address } },
  });

  if (existing) {
    console.info(
      `Already listed: ${existing.symbol} (${existing.isEnabled ? 'enabled' : 'disabled'}, ${existing.verificationTier}).`,
    );
    console.info('Enable or disable it from the admin panel rather than re-adding it.');
    return;
  }

  console.info(`Reading ${address} from Base…`);

  let symbol: string;
  let decimals: number;

  try {
    [symbol, decimals] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    ]);
  } catch (error) {
    // An address that does not answer these is not an ERC-20, and listing it
    // would put something untradeable in front of users.
    console.error(
      `That address did not answer symbol() and decimals(). It may not be an ERC-20 on Base.`,
    );
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    console.error(`Refusing to list a token reporting ${decimals} decimals.`);
    process.exit(1);
  }

  const token = await prisma.token.create({
    data: {
      id: newId(),
      chainId: BASE_CHAIN_ID,
      address,
      symbol,
      name: displayName?.trim() || symbol,
      decimals,
      verificationTier: TokenVerificationTier.UNVERIFIED,
      isEnabled: false,
      disabledReason: 'Added by add-token; not yet reviewed for trading',
    },
  });

  console.info('');
  console.info(`  ${token.symbol} · ${token.name}`);
  console.info(`  address   ${token.address}`);
  console.info(`  decimals  ${token.decimals}`);
  console.info(`  tier      ${token.verificationTier}`);
  console.info(`  status    DISABLED`);
  console.info('');
  console.info('Enable it in the admin panel when you have reviewed the contract.');
  console.info('Raising its verification tier is a separate, deliberate decision.');
}

main()
  .catch((error) => {
    console.error('Failed to add the token:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
