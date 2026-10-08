import { z } from 'zod';
import { env } from '@flt/config';
import { ValidationError } from '@flt/core/domain';
import { blockedEmailReason } from '@flt/core/domain/email-domains';
import { signupBotSignal } from '@flt/core/domain/signup-signals';
import { assertPasswordPolicy, register, RateLimits } from '@flt/core/services';
import { mailProvider, provisionWalletsForUser } from '@flt/providers';
import { handler } from '@/server/api';
import { setSessionCookie } from '@/server/session';
import { assertTurnstile } from '@/server/turnstile';

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
 *
 * ## Automated signups
 *
 * Undeliverable domains (example.com and the rest of RFC 2606) and public
 * disposable inboxes are refused outright — see `blockedEmailReason`.
 *
 * Three layers, cheapest first: the per-IP rate limit, the honeypot and
 * fill-time signals (`signupBotSignal`), and Cloudflare Turnstile when it is
 * configured. A honeypot or timing hit gets the ordinary success message and
 * no account, so a script cannot tell it was caught.
 */
const GENERIC_RESPONSE = { message: 'Check your inbox to confirm your email address.' };

const schema = z.object({
  email: z.string().trim().email('Enter a valid email address').max(320),
  password: z.string().min(1, 'Enter a password'),
  website: z.string().max(500).optional(),
  renderedAt: z.number().int().optional(),
  turnstileToken: z.string().max(4096).optional(),
});

export const POST = handler(
  {
    auth: false,
    schema,
    rateLimit: { rule: RateLimits.REGISTER, scope: 'register' },
  },
  async ({ body, context }) => {
    const signal = signupBotSignal({ honeypot: body.website, renderedAt: body.renderedAt });
    if (signal) {
      console.warn(`[register] dropped likely automated signup (${signal}) from ${context.ip ?? 'unknown ip'}`);
      return GENERIC_RESPONSE;
    }

    /*
     * An address that can never receive mail, or a public throwaway inbox.
     * Said plainly rather than swallowed: a person who typed example.com by
     * mistake deserves to know, and a script learns nothing it did not already
     * know from the domain it chose.
     */
    const blocked = blockedEmailReason(body.email);
    if (blocked === 'undeliverable') {
      throw new ValidationError('That email address cannot receive mail. Use an address you can open.');
    }
    if (blocked === 'disposable') {
      throw new ValidationError('Temporary email addresses are not accepted. Use a permanent address.');
    }

    await assertTurnstile(body.turnstileToken, context.ip ?? null);
    assertPasswordPolicy(body.password);

    try {
      const { user, verificationToken, issued } = await register(
        { email: body.email, password: body.password },
        {
          ip: context.ip,
          userAgent: context.userAgent,
          requestId: context.requestId,
        },
      );

      await setSessionCookie(issued.token, issued.expiresAt);

      const verifyUrl = `${env().WEB_APP_URL}/xaqiiji-iimaylka?token=${verificationToken}`;
      await mailProvider().sendVerification({ to: user.email, verifyUrl });

      // Best-effort and deliberately isolated from the try/catch's normal
      // error path below: a Privy outage or misconfiguration must never
      // turn into a failed signup, and must never be mistaken for the
      // EMAIL_TAKEN case that path exists to swallow.
      try {
        await provisionWalletsForUser(user);
      } catch (error) {
        console.error(`[register] wallet provisioning failed for user ${user.id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      // A taken email is not surfaced. Anything else is a real failure.
      const code = (error as { code?: string }).code;
      if (code !== 'EMAIL_TAKEN') throw error;
    }

    return GENERIC_RESPONSE;
  },
);
