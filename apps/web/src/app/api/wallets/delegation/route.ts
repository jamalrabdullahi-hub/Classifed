import { z } from 'zod';
import { ValidationError } from '@flt/core/domain';
import {
  currentDelegation,
  grantWalletDelegation,
  revokeWalletDelegation,
} from '@flt/core/services/wallet-delegation';
import { WALLET_DELEGATION_VERSION } from '@flt/providers';
import { handler } from '@/server/api';

/**
 * FLT's permission to place transactions from a participant's FLT wallet.
 *
 * GET reports the current state and the wording in force. POST grants it, and
 * the version the interface displayed must match the one in force — a
 * participant who accepted text that has since changed has not accepted the
 * current text. DELETE withdraws it, effective immediately: the signer reads
 * this on every call rather than caching it.
 */
export const GET = handler({}, async ({ user }) => {
  const delegation = await currentDelegation(user.id);
  const live = delegation !== null && delegation.revokedAt === null;

  return {
    version: WALLET_DELEGATION_VERSION,
    granted: live && delegation.version === WALLET_DELEGATION_VERSION,
    acceptedAt: delegation?.acceptedAt ?? null,
    revokedAt: delegation?.revokedAt ?? null,
    /** True when they accepted older wording and need to accept it again. */
    stale: live && delegation.version !== WALLET_DELEGATION_VERSION,
  };
});

export const POST = handler(
  { schema: z.object({ version: z.string().trim().min(1) }) },
  async ({ user, body, context }) => {
    if (body.version !== WALLET_DELEGATION_VERSION) {
      throw new ValidationError(
        'The terms have changed since you read them. Please read them again.',
        { expected: WALLET_DELEGATION_VERSION, accepted: body.version },
      );
    }

    const delegation = await grantWalletDelegation(user, {
      version: body.version,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { granted: true, acceptedAt: delegation.acceptedAt };
  },
);

export const DELETE = handler({}, async ({ user }) => {
  await revokeWalletDelegation(user);
  return {
    granted: false,
    note:
      'FLT can no longer place transactions from your FLT wallet. Your funds are unaffected — ' +
      'the wallet and everything in it is still yours.',
  };
});
