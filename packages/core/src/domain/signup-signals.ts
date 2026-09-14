/**
 * Cheap signals that a registration was submitted by a script.
 *
 * - **Honeypot:** a field hidden from people (off-screen, `aria-hidden`, no tab
 *   stop) that form-filling bots complete anyway.
 * - **Too fast:** the form records when it was rendered; a person cannot read
 *   it, type an email and a 12-character password in under a couple of seconds.
 *
 * Neither is proof, so a hit is answered with the ordinary success message and
 * no account — a bot learns nothing from the response to adapt against.
 * Missing timing (an old cached form, JavaScript quirks) is not treated as a
 * hit; a future timestamp, or one older than a day, is ignored the same way.
 */

export const MIN_FILL_MS = 2_500;
const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1_000;

export type SignupSignal = 'honeypot' | 'too_fast';

export function signupBotSignal(
  input: { honeypot?: string | null; renderedAt?: number | null },
  now: number = Date.now(),
): SignupSignal | null {
  if ((input.honeypot ?? '').trim().length > 0) return 'honeypot';

  const renderedAt = input.renderedAt;
  if (typeof renderedAt === 'number' && Number.isFinite(renderedAt)) {
    const elapsed = now - renderedAt;
    if (elapsed >= 0 && elapsed < MIN_FILL_MS) return 'too_fast';
    if (elapsed > MAX_FORM_AGE_MS) return null;
  }
  return null;
}
