import { z } from 'zod';
import { env } from '@flt/config';
import { assertPasswordPolicy, register, RateLimits } from '@flt/core/services';
import { mailProvider } from '@flt/providers';
import { handler } from '@/server/api';

/**
 * Registration.
 *
 * Always reports success. A distinct "that email is taken" response is an
 * account-enumeration oracle, and the user experience is identical either way:
 * check your inbox. Someone who already has an account gets no email and can
 * use the reset flow.
 */
const schema = z.object({
  email: z.string().trim().email('Enter a valid email address').max(320),
  password: z.string().min(1, 'Enter a password'),
});

export const POST = handler(
  {
    auth: false,
    schema,
    rateLimit: { rule: RateLimits.REGISTER, scope: 'register' },
  },
  async ({ body, context }) => {
    assertPasswordPolicy(body.password);

    try {
      const { user, verificationToken } = await register(body, {
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });

      const verifyUrl = `${env().WEB_APP_URL}/xaqiiji-iimaylka?token=${verificationToken}`;
      await mailProvider().sendVerification({ to: user.email, verifyUrl });
    } catch (error) {
      // A taken email is not surfaced. Anything else is a real failure.
      const code = (error as { code?: string }).code;
      if (code !== 'EMAIL_TAKEN') throw error;
    }

    return { message: 'Check your inbox to confirm your email address.' };
  },
);
