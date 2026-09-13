import { encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { env } from '@flt/config';
import { ProviderNotConfiguredError, ValidationError, Decimal } from '@flt/core/domain';
import { fundVenueMargin } from '@flt/core/services';
import { sendOmnibusTransaction } from '../custody/omnibus';

/**
 * Funding the Hyperliquid account from the omnibus.
 *
 * ## Why Arbitrum, and why a plain transfer
 *
 * HyperCore's USDC does not come from Base. The only USDC deposit rail is on
 * **Arbitrum** (Circle CCTP, or Hyperliquid's legacy bridge — see
 * `docs/PERPS-CUSTODY-DESIGN.md`). The legacy bridge credits "the account that
 * sent it", and the sender is the omnibus, so a plain USDC transfer funds the
 * **omnibus's** HyperCore account with no cross-chain message to assemble.
 *
 * ## The floor is real
 *
 * Below the bridge minimum the deposit is not credited and is lost forever —
 * so this refuses rather than warning. The amount is a plain transfer; nothing
 * here is reversible, which is why the guard is in front of it.
 */

const ARBITRUM_CHAIN_ID = 42161;

/** Circle's native USDC on Arbitrum. The bridge wants native, not USDC.e. */
const USDC_ARBITRUM: Hex = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

/** Hyperliquid's Arbitrum deposit bridge. Credits the sender. */
const HYPERLIQUID_BRIDGE: Hex = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';

/** Deposits below this are not credited and are lost. */
const MIN_DEPOSIT_USDC = 5;

export async function fundHyperliquidFromArbitrum(amountUsdc: string): Promise<Hex> {
  const amount = Number(amountUsdc);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('The deposit amount must be a positive number', { amountUsdc });
  }
  if (amount < MIN_DEPOSIT_USDC) {
    throw new ValidationError(
      `Hyperliquid does not credit deposits below ${MIN_DEPOSIT_USDC} USDC — the funds would be lost.`,
      { amountUsdc, min: MIN_DEPOSIT_USDC },
    );
  }

  const { OMNIBUS_EVM_ADDRESS, OMNIBUS_EVM_WALLET_ID } = env();
  if (!OMNIBUS_EVM_ADDRESS || !OMNIBUS_EVM_WALLET_ID) {
    throw new ProviderNotConfiguredError(
      'privy-custody',
      'OMNIBUS_EVM_ADDRESS and OMNIBUS_EVM_WALLET_ID are required to fund the venue',
    );
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [HYPERLIQUID_BRIDGE, BigInt(Math.round(amount * 1e6))],
  });

  /**
   * Through the shared omnibus send, so this queues behind whatever else the
   * wallet is doing.
   *
   * Venue funding is rare but it is not special: it spends the same nonce
   * sequence as every trade, sweep and withdrawal. Building its own client here
   * meant a funding transfer issued while a swap was in flight took the nonce
   * already in use and was rejected.
   */
  const hash = await sendOmnibusTransaction({
    chainId: ARBITRUM_CHAIN_ID,
    to: USDC_ARBITRUM,
    data,
    value: '0',
  });

  /**
   * Post the ledger movement once the transfer is broadcast. Idempotent on the
   * tx hash, so a retry cannot double-count. If it fails the money is already at
   * the venue, so it is a bookkeeping problem the reconciliation job surfaces —
   * not a reason to lose the hash.
   */
  await fundVenueMargin({ amount: new Decimal(amount), reference: `venue-fund:${hash}` });

  return hash;
}
