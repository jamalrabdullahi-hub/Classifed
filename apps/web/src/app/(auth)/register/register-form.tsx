'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Check, MailCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('auth');
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
      setError(caught instanceof ApiError ? caught.message : t('register.genericError'));
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
          {t('register.checkInboxTitle')}
        </h1>
        <p className="mx-auto mt-2 max-w-[320px] text-[13px] leading-relaxed text-[var(--text-muted)]">
          {t('register.checkInboxBody', { email })}
        </p>
        <Button asChild variant="secondary" className="mt-6">
          <Link href="/login">{t('register.goToSignIn')}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="animate-fade-up">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">
          {t('register.heading')}
        </h1>
        <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">
          {t('register.haveAccount')}{' '}
          <Link href="/login" className="link">
            {t('register.signIn')}
          </Link>
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4">
        {error ? <Notice tone="negative">{error}</Notice> : null}

        <Field label={t('email')}>
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

        <Field label={t('password')}>
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
                {t('register.passwordHint', { count: MIN_PASSWORD_LENGTH })}
              </p>
            </>
          )}
        </Field>

        <Button type="submit" variant="primary" block loading={pending} disabled={!longEnough}>
          {t('register.submit')}
        </Button>

        <p className="text-center text-[12px] leading-relaxed text-[var(--text-subtle)]">
          {t('register.disclaimer')}
        </p>
      </form>
    </div>
  );
}
