'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, Field, Input, Notice } from '@flt/ui';
import { ApiError, post } from '@/lib/api';

interface LoginResponse {
  mfaRequired: boolean;
  emailVerified: boolean;
  accountStatus: string;
}

/**
 * Sign-in.
 *
 * Two states in one component: credentials, then the MFA challenge. Keeping
 * them together means the password never has to be held in memory across a
 * navigation, and the user is not bounced to a second URL mid-flow.
 */
export function LoginForm() {
  const router = useRouter();
  const t = useTranslations('auth');
  const [stage, setStage] = useState<'credentials' | 'mfa'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onCredentials(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const result = await post<LoginResponse>('/api/auth/login', { email, password });

      if (result.mfaRequired) {
        setStage('mfa');
        // The password has served its purpose; do not keep it around.
        setPassword('');
        return;
      }

      router.replace('/dashboard');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('login.genericError'));
    } finally {
      setPending(false);
    }
  }

  async function onChallenge(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      await post('/api/auth/mfa', { code });
      router.replace('/dashboard');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('login.mfaError'));
      setCode('');
    } finally {
      setPending(false);
    }
  }

  if (stage === 'mfa') {
    return (
      <div className="animate-fade-up">
        <header className="mb-6">
          <div className="mb-3 flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-[var(--accent-border)] bg-[var(--accent-subtle)]">
            <ShieldCheck className="size-4 text-[var(--accent-text)]" />
          </div>
          <h1 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">
            {t('login.mfaTitle')}
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
            {t('login.mfaBody')}
          </p>
        </header>

        <form onSubmit={onChallenge} className="space-y-4">
          {error ? <Notice tone="negative">{error}</Notice> : null}

          <Field label={t('login.authCode')} error={null}>
            {(props) => (
              <Input
                {...props}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                inputMode="text"
                placeholder="000000"
                className="num text-center text-lg tracking-[0.3em]"
                autoFocus
                required
              />
            )}
          </Field>

          <Button type="submit" variant="primary" block loading={pending}>
            {t('login.verify')}
          </Button>

          <button
            type="button"
            onClick={() => {
              setStage('credentials');
              setError(null);
              setCode('');
            }}
            className="w-full text-center text-[13px] text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            {t('backToSignIn')}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="animate-fade-up">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">
          {t('login.heading')}
        </h1>
        <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">
          {t('login.noAccount')}{' '}
          <Link href="/register" className="link">
            {t('login.openOne')}
          </Link>
        </p>
      </header>

      <form onSubmit={onCredentials} className="space-y-4">
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

        <Field
          label={t('password')}
          action={
            <Link
              href="/forgot-password"
              className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              {t('forgotShort')}
            </Link>
          }
        >
          {(props) => (
            <Input
              {...props}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          )}
        </Field>

        <Button type="submit" variant="primary" block loading={pending}>
          {t('login.signIn')}
        </Button>
      </form>
    </div>
  );
}
