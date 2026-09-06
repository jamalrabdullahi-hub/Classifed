'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { KeyRound, ShieldX } from 'lucide-react';
import { Button, Field, Input, Notice } from '@flt/ui';
import { ApiError, post } from '@/lib/api';

/**
 * Sets a new password from a reset token.
 *
 * The length requirement is stated before the user types rather than returned
 * as an error afterwards. Someone resetting a password has usually just failed
 * to log in and is already frustrated; being told the rule only after breaking
 * it is a second avoidable failure.
 */
const MIN_PASSWORD_LENGTH = 12;

export function ResetPasswordForm({ token }: { token: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div className="animate-fade-up space-y-4">
        <header>
          <div className="mb-3 flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-raised)]">
            <ShieldX className="size-4 text-[var(--warning)]" />
          </div>
          <h1 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">
            This link is incomplete
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
            The address you opened has no reset code in it. Open the link from your email directly,
            or request a new one.
          </p>
        </header>
        <Button asChild variant="primary" block>
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </div>
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (password !== confirmation) {
      setError('Those passwords do not match.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setPending(true);
    try {
      await post('/api/auth/password-reset/confirm', { token, password });
      setDone(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'That link could not be used. It may have expired.',
      );
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="animate-fade-up space-y-4">
        <header>
          <div className="mb-3 flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-raised)]">
            <KeyRound className="size-4 text-[var(--positive)]" />
          </div>
          <h1 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">
            Password changed
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
            Any other sessions signed in with the old password have been ended.
          </p>
        </header>
        <Button variant="primary" block onClick={() => router.push('/login')}>
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="animate-fade-up">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">
          Choose a new password
        </h1>
        <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">
          At least {MIN_PASSWORD_LENGTH} characters. A long passphrase beats a short complicated
          one.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4">
        {error ? <Notice tone="negative">{error}</Notice> : null}

        <Field label="New password">
          {(props) => (
            <Input
              {...props}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
              autoFocus
            />
          )}
        </Field>

        <Field label="Confirm new password">
          {(props) => (
            <Input
              {...props}
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="new-password"
              required
            />
          )}
        </Field>

        <Button type="submit" variant="primary" block loading={pending}>
          Change password
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
