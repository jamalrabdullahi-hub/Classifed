import { z } from 'zod';
import { env } from '@flt/config';
import { assertPasswordPolicy, register, RateLimits } from '@flt/core/services';
import { mailProvider } from '@flt/providers';
import { handler } from '@/server/api';
import { setSessionCookie } from '@/server/session';

/**
 * Registration.
 *
 * The response body is always the same shape. A distinct "that email is
 * taken" response is an account-enumeration oracle, so the caller cannot
 * tell a fresh signup from a repeat one by reading what comes back.
 *
 * Email verification is a security recommendation shown on the dashboard,
 * not a login gate — see the account-status comment in `register()` — so a
 * successful signup is signed in immediately rather than left to complete a
 * second manual login. That does mean this route's *headers* differ (a
 * fresh signup gets a session cookie; a repeat one does not), which a raw
 * HTTP client — not a browser page, which cannot read Set-Cookie via script
 * — could in principle use to probe for a registered email. Registration is
 * tightly rate-limited for that and other reasons; a byte-identical
 * response would mean logging the caller into a stranger's account on a
 * repeat signup, which is a worse failure mode than that narrow signal.
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
      const { user, verificationToken, issued } = await register(body, {
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });

      await setSessionCookie(issued.token, issued.expiresAt);

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
