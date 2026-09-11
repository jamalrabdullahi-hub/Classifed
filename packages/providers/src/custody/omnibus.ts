import { createWalletClient, http, publicActions, type Hex } from 'viem';
import { createViemAccount } from '@privy-io/node/viem';
import { env } from '@flt/config';
import { ProviderNotConfiguredError } from '@flt/core/domain';
import { requireChain } from '@flt/core/chains';
import { privyClient } from '../wallet-provisioning/privy';

/**
 * Broadcasting a transaction from the omnibus wallet.
 *
 * The single signing path for the pooled wallet — spot trades and withdrawals
 * both go through it. There is deliberately no delegation gate here: the
 * omnibus is FLT's own wallet, and the consent a `WalletDelegation` records is
 * about acting for a *participant*, which has no meaning for FLT acting for
 * itself.
 *
 * The transaction is passed in already built and is not modified, so what is
 * signed is what the quote service produced — the same discipline the
 * participant-signed path keeps.
 */
export async function sendOmnibusTransaction(params: {
  chainId: number;
  to: string;
  data: string;
  value: string;
  gas?: string | null;
}): Promise<Hex> {
  const { OMNIBUS_EVM_ADDRESS, OMNIBUS_EVM_WALLET_ID } = env();
  if (!OMNIBUS_EVM_ADDRESS || !OMNIBUS_EVM_WALLET_ID) {
    throw new ProviderNotConfiguredError(
      'privy-custody',
      'OMNIBUS_EVM_ADDRESS and OMNIBUS_EVM_WALLET_ID are not configured',
    );
  }

  const chain = requireChain(params.chainId);
  const account = await createViemAccount(privyClient(), {
    walletId: OMNIBUS_EVM_WALLET_ID,
    address: OMNIBUS_EVM_ADDRESS as Hex,
  });

  const client = createWalletClient({
    account,
    chain: chain.viemChain,
    transport: http(chain.rpcUrl()),
  }).extend(publicActions);

  return client.sendTransaction({
    account,
    chain: chain.viemChain,
    to: params.to as Hex,
    data: params.data as Hex,
    value: BigInt(params.value),
    ...(params.gas ? { gas: BigInt(params.gas) } : {}),
  });
}
