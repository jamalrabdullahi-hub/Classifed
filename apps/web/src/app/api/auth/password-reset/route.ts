import { z } from 'zod';
import { env } from '@flt/config';
import { RateLimits, requestPasswordReset } from '@flt/core/services';
import { mailProvider } from '@flt/providers';
import { handler } from '@/server/api';

/**
 * Request a password reset.
 *
 * Always reports success, whether or not the address is registered. Confirming
 * which addresses have accounts is a real information leak, and the honest
 * message covers both cases.
 */
const schema = z.object({ email: z.string().trim().email() });

export const POST = handler(
  {
    auth: false,
    schema,
    rateLimit: { rule: RateLimits.PASSWORD_RESET, scope: 'password-reset' },
  },
  async ({ body, context }) => {
    const result = await requestPasswordReset(body.email, {
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    if (result) {
      await mailProvider().sendPasswordReset({
        to: result.user.email,
        resetUrl: `${env().WEB_APP_URL}/reset-password?token=${result.token}`,
        expiresInMinutes: 60,
      });
    }

    return { message: 'If that address has an account, a reset link is on its way.' };
  },
);
