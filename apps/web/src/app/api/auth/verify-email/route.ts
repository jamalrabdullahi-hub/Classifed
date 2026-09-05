import { z } from 'zod';
import { RateLimits, verifyEmail } from '@flt/core/services';
import { handler } from '@/server/api';

const schema = z.object({ token: z.string().trim().min(16).max(200) });

export const POST = handler(
  {
    auth: false,
    schema,
    rateLimit: { rule: RateLimits.EMAIL_RESEND, scope: 'verify-email' },
  },
  async ({ body, context }) => {
    const user = await verifyEmail(body.token, {
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
    return { email: user.email, verified: true };
  },
);
