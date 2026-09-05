import { z } from 'zod';
import { RateLimits, assertPasswordPolicy, resetPassword } from '@flt/core/services';
import { handler } from '@/server/api';
import { clearSessionCookie } from '@/server/session';

const schema = z.object({
  token: z.string().trim().min(16).max(200),
  password: z.string().min(1),
});

export const POST = handler(
  {
    auth: false,
    schema,
    rateLimit: { rule: RateLimits.PASSWORD_RESET, scope: 'password-reset-confirm' },
  },
  async ({ body, context }) => {
    assertPasswordPolicy(body.password);

    await resetPassword(
      { token: body.token, newPassword: body.password },
      { ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
    );

    // Every session was revoked, including any this browser holds.
    await clearSessionCookie();
    return { message: 'Your password has been changed. Sign in with your new password.' };
  },
);
