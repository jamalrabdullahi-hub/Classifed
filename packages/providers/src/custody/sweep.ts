import { encodeFunctionData, erc20Abi } from 'viem';
import { env } from '@flt/config';
import type { Wallet } from '@flt/db';
import { ProviderNotConfiguredError } from '@flt/core/domain';
import { sendDepositSweepTransaction } from '../wallet-provisioning/signer';

/**
 * Sweeping a participant's stablecoin into the omnibus.
 *
 * Part of the deposit flow: a participant sends USDC/USDT to their own FLT
 * deposit address, and this moves it into the pooled wallet FLT controls. Only
 * after the sweep is mined is the participant's ledger balance credited — see
 * `creditCryptoDeposit`.
 *
 * ## Consent: depositing is the authorisation
 *
 * A deposit to a participant's FLT address is itself the authorisation to
 * consolidate it — the operator chose this so the product needs no separate
 * "let FLT move your funds" step. The sweep therefore uses
 * `sendDepositSweepTransaction`, the one signing path that does not require a
 * `WalletDelegation` grant, rather than `sendManagedTransaction`. That grant
 * gate still applies to every other use of a participant's wallet.
 */
export async function sweepErc20ToOmnibus(params: {
  wallet: Wallet;
  tokenAddress: string;
  /** Base units, as the chain reported them. */
  amountBaseUnits: string;
}): Promise<`0x${string}`> {
  const { OMNIBUS_EVM_ADDRESS } = env();
  if (!OMNIBUS_EVM_ADDRESS) {
    throw new ProviderNotConfiguredError(
      'privy-custody',
      'OMNIBUS_EVM_ADDRESS is not configured, so there is nowhere to sweep to',
    );
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [OMNIBUS_EVM_ADDRESS as `0x${string}`, BigInt(params.amountBaseUnits)],
  });

  return sendDepositSweepTransaction({
    wallet: params.wallet,
    to: params.tokenAddress,
    data,
    value: '0',
  });
}
