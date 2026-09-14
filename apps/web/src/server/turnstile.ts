import { env } from '@flt/config';
import { ValidationError } from '@flt/core/domain';

/**
 * Cloudflare Turnstile, checked on the server.
 *
 * Off unless `TURNSTILE_SECRET_KEY` is set, so development and tests need no
 * Cloudflare account. When on, a missing or rejected token stops the request
 * before anything is created. The check is Cloudflare's own endpoint; the token
 * is single-use and bound to the visitor's IP when one is known.
 */
export async function assertTurnstile(token: string | undefined, ip: string | null): Promise<void> {
  const secret = env().TURNSTILE_SECRET_KEY;
  if (!secret) return;

  if (!token) throw new ValidationError('Complete the security check and try again.');

  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set('remoteip', ip);

  let ok = false;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(5_000),
    });
    ok = ((await response.json()) as { success?: boolean }).success === true;
  } catch (error) {
    console.error('[turnstile] verification request failed', error);
  }

  if (!ok) throw new ValidationError('The security check did not pass. Reload the page and try again.');
}
