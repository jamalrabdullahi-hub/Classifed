'use client';

import { useState } from 'react';
import { Button } from '@flt/ui';
import { ApiError, post } from '@/lib/api';

/**
 * Asks for a fresh confirmation email.
 *
 * Lives beside the "confirm your email" notice because that notice previously
 * told the user a link had been sent and then offered no way to act on it. If
 * the mail never arrived — or, for every account created before the
 * confirmation page existed, if its link went to a dead page — the account was
 * simply stuck with nothing on screen to do about it.
 */
export function ResendVerification({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'confirmed'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setError(null);
    setState('sending');

    try {
      const result = await post<{ sent: boolean; alreadyConfirmed: boolean }>(
        '/api/auth/verify-email/resend',
        {},
      );
      setState(result.alreadyConfirmed ? 'confirmed' : 'sent');
    } catch (caught) {
      setState('idle');
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not send the email. Try again in a moment.',
      );
    }
  }

  if (state === 'confirmed') {
    return (
      <p className="mt-3 text-[13px] text-[var(--text-muted)]">
        This address is already confirmed. Reload the page to see the change.
      </p>
    );
  }

  if (state === 'sent') {
    return (
      <p className="mt-3 text-[13px] text-[var(--text-muted)]">
        Sent to <span className="num">{email}</span>. The link works once and expires in 24 hours —
        check your spam folder if it does not arrive.
      </p>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <Button variant="primary" size="sm" onClick={send} loading={state === 'sending'}>
        Send a new confirmation link
      </Button>
      {error ? <p className="text-[12px] text-[var(--negative)]">{error}</p> : null}
    </div>
  );
}
