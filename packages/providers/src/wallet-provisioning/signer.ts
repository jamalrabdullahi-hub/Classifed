import { createViemAccount } from '@privy-io/node/viem';
import { createWalletClient, http, publicActions, type Hex } from 'viem';
import { prisma, type Wallet } from '@flt/db';
import { ForbiddenError, ValidationError } from '@flt/core/domain';
import { findChain } from '@flt/core/chains';
import { privyClient } from './privy';

/**
 * Signing with an FLT-provisioned wallet.
 *
 * ## What this is, and what it is not
 *
 * Not custody. The key lives with Privy's infrastructure and no part of FLT
 * ever sees it — this module asks Privy to sign, it does not sign. But asking
 * on somebody's behalf is a real power, so every path through here requires an
 * unrevoked `WalletDelegation` at the current version. A participant who has
 * not granted it, or has withdrawn it, cannot be transacted for, and the
 * failure is a refusal rather than a fallback to some other wallet.
 *
 * ## Only wallets FLT provisioned
 *
 * A wallet the participant linked themselves — MetaMask, a hardware wallet —
 * has no `providerWalletId`, and nothing here can act on it. That is the
 * property worth keeping: connecting your own wallet to FLT must never be the
 * same act as authorising FLT to spend from it.
 */

/**
 * The wording a participant accepts. Bump this when the terms change, which
 * invalidates every delegation accepted under the old text.
 */
export const WALLET_DELEGATION_VERSION = 'delegation-v1';

/** True when this participant has a live delegation at the current version. */
export async function hasWalletDelegation(userId: string): Promise<boolean> {
  const delegation = await prisma.walletDelegation.findUnique({ where: { userId } });
  return (
    delegation !== null &&
    delegation.revokedAt === null &&
    delegation.version === WALLET_DELEGATION_VERSION
  );
}

/** True when FLT provisioned this wallet and can therefore ask Privy about it. */
export function isManagedWallet(wallet: Wallet): boolean {
  return wallet.connector === 'privy-embedded' && Boolean(wallet.providerWalletId);
}

/**
 * A viem account backed by the participant's Privy wallet.
 *
 * Returns a standard `LocalAccount`, which is the reason this integration is
 * one piece of work rather than one per venue: anything that accepts a viem
 * account — an ERC-20 transfer, DEX swap calldata, a Hyperliquid order — works
 * unchanged.
 */
export async function managedAccountFor(wallet: Wallet) {
  if (!isManagedWallet(wallet)) {
    throw new ValidationError(
      'That wallet was linked by its owner, so FLT cannot sign for it. Sign in your own wallet instead.',
    );
  }
  if (!(await hasWalletDelegation(wallet.userId))) {
    throw new ForbiddenError(
      'You have not authorised FLT to place transactions from your FLT wallet, or that ' +
        'authorisation has been withdrawn.',
    );
  }

  return createViemAccount(privyClient(), {
    walletId: wallet.providerWalletId!,
    address: wallet.address as Hex,
  });
}

/**
 * Signs and broadcasts one prepared transaction from a participant's FLT
 * wallet, returning the hash.
 *
 * The transaction is passed in already built — by the quote service, or by
 * whatever prepared it — and is not modified here. That separation is what
 * keeps the preview binding: what gets signed is what the participant was
 * shown, and this module has no opinion about its contents.
 */
export async function sendManagedTransaction(params: {
  wallet: Wallet;
  to: string;
  data: string;
  value: string;
  gas?: string | null;
}): Promise<Hex> {
  const chain = findChain(params.wallet.chainId);
  if (!chain) {
    throw new ValidationError('That wallet is on a chain this deployment does not support', {
      chainId: params.wallet.chainId,
    });
  }

  const account = await managedAccountFor(params.wallet);

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
