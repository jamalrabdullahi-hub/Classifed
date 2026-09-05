import { z } from 'zod';
import { confirmEnrollment } from '@flt/core/services/mfa';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Confirms enrolment and returns the recovery codes.
 *
 * The codes are returned exactly once. Only their hashes are stored, so this
 * response is the only time they exist in readable form.
 */
const schema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the six-digit code') });

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.MFA_CHALLENGE, scope: 'mfa-confirm' } },
  async ({ body, user, context }) => {
    const result = await confirmEnrollment(user, body.code, {
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return { recoveryCodes: result.recoveryCodes };
  },
);
