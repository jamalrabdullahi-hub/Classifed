import { parseEther, type Address } from 'viem';
import { env } from '@flt/config';
import { BASE_CHAIN_ID, publicClient, requireChain } from '@flt/core/chains';
import { dexRouter } from '../registry';
import { sendOmnibusTransaction } from './omnibus';

/**
 * Keeping a wallet's gas paid for, funded from the platform's own reserve.
 *
 * A participant's FLT deposit address is created with no native balance, and
 * the sweep is a transaction *from* that address — so with no gas it can never
 * move, and the deposit can never be credited. This tops such a wallet up: it
 * reads the wallet's native balance, makes sure the omnibus holds a reserve
 * (buying the chain's gas asset with omnibus USDC when it runs low), and sends
 * a small amount across.
 *
 * The gas asset is whatever the chain uses — ETH on Base, BNB on BNB Chain —
 * looked up rather than assumed. All sends go through `sendOmnibusTransaction`,
 * which is serialized, so a top-up and a buy cannot collide on the omnibus's
 * nonce.
 */

/** The pseudo-address aggregators use for a chain's native asset. */
const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
/** Base USDC — the asset the omnibus swaps for gas. */
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Below this, a wallet is treated as needing gas. */
const WALLET_FLOOR_WEI = parseEther('0.00002');
/** What we send a wallet that needs gas. */
const WALLET_TOPUP_WEI = parseEther('0.00005');
/** Below this, the omnibus's own reserve is replenished. */
const RESERVE_FLOOR_WEI = parseEther('0.0001');
/** How much USDC the omnibus spends to replenish (Base USDC, 6 decimals). */
const RESERVE_BUY_USDC = '2000000';

/** The native gas asset of a chain: ETH (8453), BNB (56), … */
export function gasAssetFor(chainId: number): { symbol: string; decimals: number } {
  const chain = requireChain(chainId);
  return { symbol: chain.nativeSymbol, decimals: chain.nativeDecimals };
}

/**
 * Ensures `address` has enough native balance for a transaction, returning the
 * top-up hash or null when it already had enough. Idempotent and cheap when
 * nothing is needed.
 */
export async function ensureWalletGas(params: {
  chainId: number;
  address: string;
}): Promise<string | null> {
  const { OMNIBUS_EVM_ADDRESS } = env();
  if (!OMNIBUS_EVM_ADDRESS) return null;

  const client = publicClient(params.chainId);
  const balance = await client.getBalance({ address: params.address as Address });
  if (balance >= WALLET_FLOOR_WEI) return null;

  await replenishReserveIfLow(params.chainId);

  return sendOmnibusTransaction({
    chainId: params.chainId,
    to: params.address,
    data: '0x',
    value: WALLET_TOPUP_WEI.toString(),
  });
}

/**
 * Buys the chain's gas asset with omnibus USDC when the omnibus reserve is low.
 *
 * The swap is done from the omnibus (which already holds a USDC allowance to
 * the router), buying the native asset directly — so what lands is gas, not a
 * wrapped token that would need unwrapping. Base only for now: it needs a
 * registered sell token and a chain the router routes, and only Base has both.
 */
async function replenishReserveIfLow(chainId: number): Promise<void> {
  const { OMNIBUS_EVM_ADDRESS } = env();
  if (!OMNIBUS_EVM_ADDRESS || chainId !== BASE_CHAIN_ID) return;

  const client = publicClient(chainId);
  const reserve = await client.getBalance({ address: OMNIBUS_EVM_ADDRESS as Address });
  if (reserve >= RESERVE_FLOOR_WEI) return;

  const quote = await dexRouter().getQuote({
    chainId,
    sellTokenAddress: USDC_BASE,
    buyTokenAddress: NATIVE_SENTINEL,
    sellAmount: RESERVE_BUY_USDC,
    sellTokenDecimals: 6,
    buyTokenDecimals: 18,
    takerAddress: OMNIBUS_EVM_ADDRESS,
    slippageBps: 100,
  });
  if (!quote.liquidityAvailable || BigInt(quote.buyAmount) <= 0n) {
    console.error('[gas] could not buy the gas asset: no liquidity');
    return;
  }

  await sendOmnibusTransaction({
    chainId,
    to: quote.transaction.to,
    data: quote.transaction.data,
    value: quote.transaction.value,
    gas: quote.transaction.gas,
  });
}
