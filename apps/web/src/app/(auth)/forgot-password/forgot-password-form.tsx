'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { MailCheck } from 'lucide-react';
import { Button, Field, Input, Notice } from '@flt/ui';
import { ApiError, post } from '@/lib/api';

/**
 * Requests a password reset link.
 *
 * The confirmation is deliberately identical whether or not the address has an
 * account. Saying "no account with that email" turns this form into a way to
 * test whether someone banks here, which is worth more to an attacker than it
 * is to the person who mistyped their address.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      await post('/api/auth/password-reset', { email });
      setSent(true);
    } catch (caught) {
      // A rate limit is worth surfacing; anything else would leak whether the
      // address exists, so it falls back to the same neutral confirmation.
      if (caught instanceof ApiError && caught.code === 'RATE_LIMITED') {
        setError(caught.message);
      } else {
        setSent(true);
      }
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <div className="animate-fade-up space-y-4">
        <header>
          <div className="mb-3 flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-raised)]">
            <MailCheck className="size-4 text-[var(--text)]" />
          </div>
          <h1 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">
            Check your inbox
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
            If an account exists for {email || 'that address'}, we have sent a link to reset the
            password. It can be used once and expires in an hour.
          </p>
        </header>

        <Button asChild variant="secondary" block>
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="animate-fade-up">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">
          Reset your password
        </h1>
        <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">
          We will email you a link to choose a new one.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4">
        {error ? <Notice tone="negative">{error}</Notice> : null}

        <Field label="Email">
          {(props) => (
            <Input
              {...props}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              required
              autoFocus
            />
          )}
        </Field>

        <Button type="submit" variant="primary" block loading={pending}>
          Send reset link
        </Button>

        <Link
          href="/login"
          className="block w-full text-center text-[13px] text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Back to sign in
        </Link>
      </form>
    </div>
  );
}
