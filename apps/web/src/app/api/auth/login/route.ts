import { z } from 'zod';
import { RateLimits, login } from '@flt/core/services';
import { handler } from '@/server/api';
import { setDeviceCookie, setSessionCookie } from '@/server/session';
import { readDeviceCookie } from '@/server/session';

/**
 * Sign in.
 *
 * Returns `mfaRequired` rather than a session when a second factor is enabled.
 * The session cookie is still set — the challenge needs something to attach to
 * — but `resolveSession` refuses to return a user for a session that has not
 * cleared MFA, so the cookie alone grants nothing.
 */
const schema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

export const POST = handler(
  {
    auth: false,
    schema,
    // Keyed by IP here. A per-account limit would let an attacker lock a victim
    // out of their own account by failing logins on purpose.
    rateLimit: { rule: RateLimits.LOGIN, scope: 'login' },
  },
  async ({ body, context }) => {
    const result = await login(body, {
      ip: context.ip,
      userAgent: context.userAgent,
      deviceCookie: await readDeviceCookie(),
      requestId: context.requestId,
    });

    await setSessionCookie(result.issued.token, result.issued.expiresAt);
    if (result.issued.deviceCookie) {
      await setDeviceCookie(result.issued.deviceCookie);
    }

    return {
      mfaRequired: result.mfaRequired,
      emailVerified: result.user.emailVerifiedAt !== null,
      accountStatus: result.user.accountStatus,
    };
  },
);
