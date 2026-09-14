import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { env } from '@flt/config';
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
 * ## Signing up from Learn
 *
 * The form at learn.ftlexchange.com/signup posts here, to ftlexchange.com, with
 * credentials. The two are the same site, so the session cookie this response
 * sets is ftlexchange.com's own and the browser keeps it; the page then moves
 * to ftlexchange.com already signed in. Only the Learn origin is allowed
 * cross-origin, and only on this route.
 *
 * ## Automated signups
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

function learnOrigin(): string {
  return new URL(env().LEARN_APP_URL).origin;
}

function withCors(response: NextResponse, request: NextRequest): NextResponse {
  if (request.headers.get('origin') === learnOrigin()) {
    response.headers.set('Access-Control-Allow-Origin', learnOrigin());
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.set('Vary', 'Origin');
  }
  return response;
}

const registerHandler = handler(
  {
    auth: false,
    schema,
    rateLimit: { rule: RateLimits.REGISTER, scope: 'register' },
    allowedOrigins: [env().LEARN_APP_URL],
  },
  async ({ body, context }) => {
    const signal = signupBotSignal({ honeypot: body.website, renderedAt: body.renderedAt });
    if (signal) {
      console.warn(`[register] dropped likely automated signup (${signal}) from ${context.ip ?? 'unknown ip'}`);
      return GENERIC_RESPONSE;
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

export async function POST(request: NextRequest) {
  return withCors(await registerHandler(request), request);
}

/** CORS preflight for the Learn sign-up form. */
export async function OPTIONS(request: NextRequest) {
  const response = new NextResponse(null, { status: 204 });
  if (request.headers.get('origin') === learnOrigin()) {
    response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'content-type');
    response.headers.set('Access-Control-Max-Age', '600');
  }
  return withCors(response, request);
}
