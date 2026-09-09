import { prisma, type User } from '@flt/db';
import { env } from '@flt/config';
import { newId } from '@flt/core/domain';
import { BASE_CHAIN_ID, BNB_CHAIN_ID } from '@flt/core/chains';
import { AuditAction, audit } from '@flt/core/services/audit';
import { provisionEmbeddedWallets } from './privy';

/**
 * Automatic wallet provisioning at signup.
 *
 * The point: a low-information user should never have to know what a
 * wallet is before FLT can hold something for them to move fiat-converted
 * crypto into. What this does NOT do is give FLT a key — that would make it
 * a second deliberate exception to non-custodial design (after
 * `@flt/core/security/agent-keys`), and this codebase does not have one
 * yet. The actual key shares live with Privy's MPC infrastructure
 * (`./privy.ts`); this module only records the resulting public addresses
 * as ordinary `Wallet` rows.
 *
 * Lives in `@flt/providers` rather than `@flt/core` because it needs both
 * the venue-agnostic provisioning call and `@flt/db` directly — the same
 * layering `agent-executor.ts` uses for the same reason.
 *
 * A `Wallet` row created here is marked verified without a signature, the
 * same way `agentWallet()` in the agent-trading executor marks one
 * verified — "verified" there means "this address is under this
 * participant's control by construction," true from the moment a freshly
 * pregenerated wallet nobody else has ever touched is created, unlike a
 * participant's own pre-existing wallet, which does need a signed message.
 */

/**
 * Not a real EIP-155 chain id — Solana has none. This stands in for one so
 * the `Wallet.chainId` column can hold a Solana address without a schema
 * change for a second, non-EVM addressing scheme.
 *
 * ## It must fit in a signed 32-bit integer
 *
 * `chains.chainId` and every `chainId` column referencing it are Postgres
 * `INTEGER`, so anything above 2,147,483,647 fails at insert time with
 * "integer out of range" — which is exactly what the first version of this
 * constant did. It used 1151111081099710, the identifier LI.FI and Socket
 * use for Solana, which is fifteen digits and cannot be stored here. Widening
 * eight columns to BIGINT to accommodate one placeholder row would have been
 * the tail wagging the dog.
 *
 * 1399811149 is Solana mainnet-beta's id in the multi-chain registries that
 * do keep to 32 bits. It is far above every allocated EIP-155 id in practical
 * use, so a collision with a real EVM chain is not a live concern, and it is
 * a published convention rather than a number invented here.
 */
export const SOLANA_CHAIN_ID = 1_399_811_149;

export function autoWalletProvisioningOperational(): boolean {
  return env().AUTO_WALLET_PROVISIONING_ENABLED;
}

/**
 * Provisions and stores embedded wallets for a newly registered user.
 *
 * Deliberately best-effort: called after registration has already
 * succeeded, and a failure here (Privy down, misconfigured, rate limited)
 * must never undo or block the account creation that already happened —
 * callers should await it (so a failure is logged, not silently lost) but
 * never let it fail the request that triggered it.
 */
export async function provisionWalletsForUser(user: User): Promise<void> {
  if (!autoWalletProvisioningOperational()) return;

  const existing = await prisma.wallet.findFirst({
    where: { userId: user.id, connector: 'privy-embedded' },
  });
  if (existing) return; // Already provisioned.

  let wallets: Awaited<ReturnType<typeof provisionEmbeddedWallets>>;
  try {
    wallets = await provisionEmbeddedWallets(user.id);
  } catch (error) {
    console.error(`[auto-wallet] provisioning failed for user ${user.id}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const hasAnyWallet = await prisma.wallet.findFirst({ where: { userId: user.id } });

  await prisma.$transaction(async (tx) => {
    // Same EVM address applies to every EVM chain FLT recognizes — Base and
    // BNB Chain today — so one pregenerated key becomes two rows.
    for (const chainId of [BASE_CHAIN_ID, BNB_CHAIN_ID]) {
      await tx.wallet.create({
        data: {
          id: newId(),
          userId: user.id,
          address: wallets.evmAddress,
          chainId,
          label: 'FLT wallet',
          connector: 'privy-embedded',
          providerWalletId: wallets.evmWalletId,
          verifiedAt: new Date(),
          isPreferred: !hasAnyWallet && chainId === BASE_CHAIN_ID,
        },
      });
    }

    await tx.wallet.create({
      data: {
        id: newId(),
        userId: user.id,
        address: wallets.solanaAddress,
        chainId: SOLANA_CHAIN_ID,
        label: 'FLT wallet (Solana)',
        connector: 'privy-embedded',
        providerWalletId: wallets.solanaWalletId,
        verifiedAt: new Date(),
        isPreferred: false,
      },
    });
  });

  await audit(prisma, {
    action: AuditAction.WALLET_LINKED,
    entityType: 'User',
    entityId: user.id,
    actorType: 'SYSTEM',
    actorUserId: user.id,
    after: { connector: 'privy-embedded', chains: [BASE_CHAIN_ID, BNB_CHAIN_ID, SOLANA_CHAIN_ID] },
  });
}
