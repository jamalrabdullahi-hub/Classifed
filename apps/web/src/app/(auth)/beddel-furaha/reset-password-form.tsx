'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { KeyRound, ShieldX } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('auth');
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
            {t('reset.incompleteTitle')}
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
            {t('reset.incompleteBody')}
          </p>
        </header>
        <Button asChild variant="primary" block>
          <Link href="/dib-u-deji">{t('reset.requestNewLink')}</Link>
        </Button>
      </div>
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (password !== confirmation) {
      setError(t('reset.mismatch'));
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t('reset.tooShort', { count: MIN_PASSWORD_LENGTH }));
      return;
    }

    setPending(true);
    try {
      await post('/api/auth/password-reset/confirm', { token, password });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('reset.genericError'));
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
            {t('reset.doneTitle')}
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
            {t('reset.doneBody')}
          </p>
        </header>
        <Button variant="primary" block onClick={() => router.push('/gal')}>
          {t('reset.signIn')}
        </Button>
      </div>
    );
  }

  return (
    <div className="animate-fade-up">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">
          {t('reset.heading')}
        </h1>
        <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">
          {t('reset.hint', { count: MIN_PASSWORD_LENGTH })}
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4">
        {error ? <Notice tone="negative">{error}</Notice> : null}

        <Field label={t('reset.newPassword')}>
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

        <Field label={t('reset.confirmNewPassword')}>
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
          {t('reset.submit')}
        </Button>

        <Link
          href="/gal"
          className="block w-full text-center text-[13px] text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          {t('backToSignIn')}
        </Link>
      </form>
    </div>
  );
}
