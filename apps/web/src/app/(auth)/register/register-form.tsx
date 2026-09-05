'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Check, MailCheck } from 'lucide-react';
import { Button, Field, Input, Notice, cn } from '@flt/ui';
import { ApiError, post } from '@/lib/api';

const MIN_PASSWORD_LENGTH = 12;

/**
 * Registration.
 *
 * The password requirement is length, not composition. Arbitrary character
 * rules push people toward predictable substitutions without adding real
 * entropy, so the only rule shown is the only rule enforced.
 */
export function RegisterForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  const longEnough = password.length >= MIN_PASSWORD_LENGTH;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      await post('/api/auth/register', { email, password });
      setSent(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not create the account. Try again.',
      );
    } finally {
      setPending(false);
    }
  }

  // Shown whether or not the address was already registered. The response is
  // deliberately identical either way, so this screen cannot be used to find
  // out who has an account.
  if (sent) {
    return (
      <div className="animate-fade-up text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full border border-[var(--accent-border)] bg-[var(--accent-subtle)]">
          <MailCheck className="size-5 text-[var(--accent-text)]" />
        </div>
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">
          Check your inbox
        </h1>
        <p className="mx-auto mt-2 max-w-[320px] text-[13px] leading-relaxed text-[var(--text-muted)]">
          If <span className="text-[var(--text)]">{email}</span> can be registered, a confirmation
          link is on its way. The link is valid for 24 hours.
        </p>
        <Button asChild variant="secondary" className="mt-6">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="animate-fade-up">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">
          Open an FLT account
        </h1>
        <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">
          Already have one?{' '}
          <Link href="/login" className="text-[var(--accent)] hover:underline">
            Sign in
          </Link>
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

        <Field label="Password">
          {(props) => (
            <>
              <Input
                {...props}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
              <p
                className={cn(
                  'mt-1.5 flex items-center gap-1.5 text-[12px] transition-colors',
                  longEnough ? 'text-[var(--positive)]' : 'text-[var(--text-subtle)]',
                )}
              >
                <Check
                  className={cn('size-3', longEnough ? 'opacity-100' : 'opacity-35')}
                  aria-hidden="true"
                />
                At least {MIN_PASSWORD_LENGTH} characters. Length matters more than symbols.
              </p>
            </>
          )}
        </Field>

        <Button type="submit" variant="primary" block loading={pending} disabled={!longEnough}>
          Create account
        </Button>

        <p className="text-center text-[12px] leading-relaxed text-[var(--text-subtle)]">
          You will need to verify your identity before trading. FLT never asks for a seed phrase or
          private key.
        </p>
      </form>
    </div>
  );
}
