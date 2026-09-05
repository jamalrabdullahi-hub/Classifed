import { prisma } from '@flt/db';
import { beginEnrollment } from '@flt/core/services/mfa';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Starts MFA enrolment.
 *
 * Stores an unconfirmed secret. It does not become the account's second factor
 * until the user proves they can generate a valid code, so a failed QR scan
 * cannot lock them out.
 */
export const POST = handler(
  { rateLimit: { rule: RateLimits.MFA_CHALLENGE, scope: 'mfa-enroll' } },
  async ({ user }) => {
    const challenge = await beginEnrollment(prisma, user);
    return { secret: challenge.secret, uri: challenge.uri };
  },
);
