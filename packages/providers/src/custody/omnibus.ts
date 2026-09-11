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
interface OmnibusTransfer {
  chainId: number;
  to: string;
  data: string;
  value: string;
  gas?: string | null;
}

/**
 * One send at a time, and never while the wallet has a transaction in flight.
 *
 * The omnibus is a single hot wallet. Two transactions built in the same window
 * are assigned the same nonce, and the node refuses the second as a
 * "replacement transaction underpriced" — which is exactly what happens when a
 * swap is signed moments after the approval it depends on, when two people
 * trade at once, or when the sweep runs during a trade. Chaining each send
 * behind the previous one, and letting it proceed only once the pending nonce
 * has cleared, keeps one wallet's transactions in the order they were asked
 * for.
 *
 * This serializes within the process. The web and the worker are separate
 * processes sharing the wallet, so the pending-nonce wait is what carries
 * across them; the queue only guarantees ordering of the sends that share an
 * event loop.
 */
let queue: Promise<unknown> = Promise.resolve();

export async function sendOmnibusTransaction(params: OmnibusTransfer): Promise<Hex> {
  const send = () => broadcast(params);
  const result = queue.then(send, send);
  // Keep the chain alive when a send rejects, so one failure does not wedge
  // every later send behind it.
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function broadcast(params: OmnibusTransfer): Promise<Hex> {
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

  /**
   * Never build a transaction while the wallet already has one pending — the
   * next nonce the node would hand out is the one already in flight.
   *
   * Bounded: if something is genuinely stuck, the RPC's own nonce check is a
   * better judge than looping forever, and a stuck send must not hang the
   * request that asked for it.
   */
  const deadline = Date.now() + 45_000;
  for (;;) {
    const [latest, pending] = await Promise.all([
      client.getTransactionCount({ address: OMNIBUS_EVM_ADDRESS as Hex, blockTag: 'latest' }),
      client.getTransactionCount({ address: OMNIBUS_EVM_ADDRESS as Hex, blockTag: 'pending' }),
    ]);
    if (pending <= latest || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  return client.sendTransaction({
    account,
    chain: chain.viemChain,
    to: params.to as Hex,
    data: params.data as Hex,
    value: BigInt(params.value),
    ...(params.gas ? { gas: BigInt(params.gas) } : {}),
  });
}
