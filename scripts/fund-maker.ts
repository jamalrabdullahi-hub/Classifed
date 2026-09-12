import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  publicActions,
  type Hex,
} from 'viem';
import { createViemAccount } from '@privy-io/node/viem';
import { prisma } from '@flt/db';
import { requireChain } from '@flt/core/chains';
import { privyClient, provisionEmbeddedWallets } from '@flt/providers';

/**
 * Deposits USDC from the market maker's own wallet into its Hyperliquid account.
 *
 * Same rail as `fundHyperliquidFromArbitrum`, but signed by the **maker's**
 * Privy wallet rather than the omnibus. Hyperliquid's bridge credits *the sender*,
 * so a plain USDC transfer from the maker wallet funds the maker's HyperCore
 * account — no cross-chain message to assemble.
 *
 * The maker wallet must already hold USDC (and a little ETH for gas) on Arbitrum;
 * this does not move funds in from anywhere, it only bridges what is there.
 *
 * Does NOT touch the ledger: this is FLT's own capital at the venue. The ledger
 * side of house capital (PLATFORM_EQUITY -> VENUE_MARGIN) is a separate booking.
 *
 * Usage (as the app user, from the repo root):
 *   pnpm --filter @flt/db exec tsx --env-file-if-exists=../../.env ../../scripts/fund-maker.ts 200
 */
const ARBITRUM_CHAIN_ID = 42161;
const USDC_ARBITRUM: Hex = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const HYPERLIQUID_BRIDGE: Hex = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
const MIN_DEPOSIT_USDC = 5;
const MAKER_EXTERNAL_ID = 'flt-maker';

async function main(): Promise<void> {
  const arg = process.argv[2];
  const amount = Number(arg);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Usage: fund-maker.ts <usdc-amount>');
  }
  if (amount < MIN_DEPOSIT_USDC) {
    throw new Error(`Hyperliquid does not credit deposits below ${MIN_DEPOSIT_USDC} USDC.`);
  }

  const wallets = await provisionEmbeddedWallets(MAKER_EXTERNAL_ID);
  const address = wallets.evmAddress as Hex;

  const account = await createViemAccount(privyClient(), {
    walletId: wallets.evmWalletId,
    address,
  });
  const chain = requireChain(ARBITRUM_CHAIN_ID);
  const client = createWalletClient({
    account,
    chain: chain.viemChain,
    transport: http(chain.rpcUrl()),
  }).extend(publicActions);

  const [usdc, eth] = await Promise.all([
    client.readContract({ address: USDC_ARBITRUM, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    client.getBalance({ address }),
  ]);

  console.info('maker wallet   :', address);
  console.info('  Arbitrum USDC:', (Number(usdc) / 1e6).toFixed(6));
  console.info('  Arbitrum ETH :', (Number(eth) / 1e18).toFixed(6), '(gas only)');

  if (usdc < BigInt(Math.round(amount * 1e6))) {
    throw new Error(
      `The maker wallet holds ${(Number(usdc) / 1e6).toFixed(2)} USDC but needs ${amount}. ` +
        `Send USDC (plus a little ETH for gas) to ${address} on Arbitrum first.`,
    );
  }
  if (eth === 0n) {
    throw new Error(`No ETH at ${address} for gas — the deposit transaction would fail.`);
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [HYPERLIQUID_BRIDGE, BigInt(Math.round(amount * 1e6))],
  });

  const hash = await client.sendTransaction({
    account,
    chain: chain.viemChain,
    to: USDC_ARBITRUM,
    data,
    value: 0n,
  });

  console.info(`\nDeposited ${amount} USDC to the maker's Hyperliquid account. tx: ${hash}`);
  console.info('Wait for the deposit to be credited, then re-run setup-maker to authorise the agent.');
}

main()
  .catch((error) => {
    console.error('fund-maker failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
