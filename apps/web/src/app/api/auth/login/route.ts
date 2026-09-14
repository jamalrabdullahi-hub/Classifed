import { z } from 'zod';
import { UnauthenticatedError } from '@flt/core/domain';
import { signupBotSignal } from '@flt/core/domain/signup-signals';
import { RateLimits, login } from '@flt/core/services';
import { handler } from '@/server/api';
import { setDeviceCookie, setSessionCookie } from '@/server/session';
import { readDeviceCookie } from '@/server/session';
import { assertTurnstile } from '@/server/turnstile';

/**
 * Sign in.
 *
 * Returns `mfaRequired` rather than a session when a second factor is enabled.
 * The session cookie is still set — the challenge needs something to attach to
 * — but `resolveSession` refuses to return a user for a session that has not
 * cleared MFA, so the cookie alone grants nothing.
 *
 * Automated attempts are stopped before a password is checked: the per-IP rate
 * limit, the honeypot and fill-time signals, then Turnstile when configured. A
 * honeypot or timing hit is answered exactly like a wrong password, so a script
 * learns nothing about why it failed.
 */
const schema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
  website: z.string().max(500).optional(),
  renderedAt: z.number().int().optional(),
  turnstileToken: z.string().max(4096).optional(),
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
    const signal = signupBotSignal({ honeypot: body.website, renderedAt: body.renderedAt });
    if (signal) {
      console.warn(`[login] refused likely automated sign-in (${signal}) from ${context.ip ?? 'unknown ip'}`);
      throw new UnauthenticatedError('Email or password is incorrect');
    }

    await assertTurnstile(body.turnstileToken, context.ip ?? null);

    const result = await login(
      { email: body.email, password: body.password },
      {
        ip: context.ip,
        userAgent: context.userAgent,
        deviceCookie: await readDeviceCookie(),
        requestId: context.requestId,
      },
    );

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
