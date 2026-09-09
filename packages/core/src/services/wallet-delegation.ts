import { prisma, type User, type WalletDelegation } from '@flt/db';
import { NotFoundError } from '../domain/errors';
import { newId } from '../domain/id';
import { AuditAction, audit } from './audit';

/**
 * Granting and withdrawing FLT's permission to direct an FLT-provisioned
 * wallet.
 *
 * The permission itself is checked in `@flt/providers` at the point of
 * signing; this module is only how it is granted, revoked and recorded. Kept
 * in core because it is consent, and consent belongs with the other things a
 * participant agrees to rather than with the code that acts on it.
 *
 * The version is passed in by the caller and compared against what the
 * interface displayed, the same discipline the agent disclosure used: a
 * participant who accepted wording that has since changed has not accepted the
 * current wording, and the difference must not be resolved silently in FLT's
 * favour.
 */

export async function currentDelegation(userId: string): Promise<WalletDelegation | null> {
  return prisma.walletDelegation.findUnique({ where: { userId } });
}

export async function grantWalletDelegation(
  user: User,
  input: { version: string; ip?: string | null; userAgent?: string | null },
): Promise<WalletDelegation> {
  const delegation = await prisma.walletDelegation.upsert({
    where: { userId: user.id },
    create: {
      id: newId(),
      userId: user.id,
      version: input.version,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
    // Re-granting after a revocation clears the revocation rather than
    // leaving a live row that reads as withdrawn.
    update: {
      version: input.version,
      acceptedAt: new Date(),
      revokedAt: null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });

  await audit(prisma, {
    action: AuditAction.WALLET_DELEGATION_GRANTED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'wallet_delegation',
    entityId: delegation.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    after: { version: input.version },
  });

  return delegation;
}

/**
 * Withdraws the permission.
 *
 * The row is kept and stamped rather than deleted: "this permission existed
 * between these dates" is what an investigation asks, and a deleted row
 * answers nothing. Revocation takes effect immediately — the signer reads this
 * on every call rather than caching it, so there is no window in which a
 * withdrawn permission still works.
 */
export async function revokeWalletDelegation(user: User): Promise<WalletDelegation> {
  const existing = await prisma.walletDelegation.findUnique({ where: { userId: user.id } });
  if (!existing) throw new NotFoundError('Delegation');

  const revoked = await prisma.walletDelegation.update({
    where: { userId: user.id },
    data: { revokedAt: new Date() },
  });

  await audit(prisma, {
    action: AuditAction.WALLET_DELEGATION_REVOKED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'wallet_delegation',
    entityId: revoked.id,
    before: { version: existing.version, acceptedAt: existing.acceptedAt },
    after: { revokedAt: revoked.revokedAt },
  });

  return revoked;
}
