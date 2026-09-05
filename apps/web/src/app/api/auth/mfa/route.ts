import { z } from 'zod';
import { prisma } from '@flt/db';
import { UnauthenticatedError } from '@flt/core/domain';
import { RateLimits, markMfaSatisfied, verifyChallenge } from '@flt/core/services';
import { handler } from '@/server/api';
import { pendingMfaSession } from '@/server/session';

/**
 * MFA challenge during sign-in.
 *
 * `auth: false` because the caller is, by definition, not yet authenticated:
 * their session exists but has not cleared the second factor. The guard is
 * `pendingMfaSession`, which resolves that half-authenticated state and nothing
 * else.
 */
const schema = z.object({
  code: z.string().trim().min(6).max(16),
});

export const POST = handler(
  {
    auth: false,
    schema,
    rateLimit: { rule: RateLimits.MFA_CHALLENGE, scope: 'mfa' },
  },
  async ({ body, context }) => {
    const session = await pendingMfaSession();
    if (!session) throw new UnauthenticatedError();

    if (session.session.mfaSatisfiedAt) {
      return { ok: true, alreadySatisfied: true };
    }

    const result = await verifyChallenge(session.user, body.code, {
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    await markMfaSatisfied(prisma, session.session.id);
    await prisma.user.update({
      where: { id: session.user.id },
      data: { lastLoginAt: new Date() },
    });

    return { ok: true, usedRecoveryCode: result.usedRecoveryCode };
  },
);
