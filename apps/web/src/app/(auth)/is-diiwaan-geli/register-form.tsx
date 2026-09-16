'use client';

import Link from 'next/link';
import Script from 'next/script';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Check, Eye, EyeOff } from 'lucide-react';
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
 *
 * Just email and password — nothing else is required to create an account.
 * A successful signup lands the person straight in the app, already signed
 * in; email verification is a security step surfaced on the dashboard
 * afterward, not a wall between "submit" and "use the product." The
 * response is deliberately the same shape whether or not the address was
 * already registered, so a repeat submission cannot be used to find out who
 * has an account — it reads as "go check your inbox" either way, which is
 * also correct advice for someone who forgot they already signed up.
 */
export function RegisterForm({
  turnstileSiteKey,
  destination,
  variant,
}: {
  turnstileSiteKey: string | null;
  /** Where to land after sign-up: the wallet, or the lessons for a Learn sign-up. */
  destination: string;
  /** Which promise brought them here, so the copy answers it. */
  variant: 'learn' | 'account';
}) {
  const t = useTranslations('auth');
  const router = useRouter();
  // When the form was shown, for the server's fill-time check.
  const [renderedAt] = useState(() => Date.now());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reveal, setReveal] = useState(false);

  const longEnough = password.length >= MIN_PASSWORD_LENGTH;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(event.currentTarget as HTMLFormElement);
    const website = String(form.get('website') ?? '');
    const turnstileToken = form.get('cf-turnstile-response');

    const payload = {
      email,
      password,
      website,
      renderedAt,
      ...(typeof turnstileToken === 'string' && turnstileToken ? { turnstileToken } : {}),
    };

    try {
      await post('/api/auth/register', payload);
      // A fresh signup is now signed in (session cookie set by the route).
      // A repeat submission for an already-registered email is not — the
      // response body can't tell the two apart, but this redirect can still
      // land safely on either: guriga simply bounces back to /gal if there
      // is no session, which reads as "sign in" rather than an error.
      router.push(destination);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('register.genericError'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="animate-fade-up">
      <header className="mb-5">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--text)]">
          {variant === 'learn' ? t('register.heading') : t('register.headingAccount')}
        </h1>
        <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">
          {t('register.timeHint')} · {t('register.haveAccount')}{' '}
          <Link href="/gal" className="link">
            {t('register.signIn')}
          </Link>
        </p>

        {/* What the account actually gives them, in their own terms. */}
        <ul className="mt-4 space-y-2">
          {(t.raw(variant === 'learn' ? 'register.learnPoints' : 'register.accountPoints') as string[]).map(
            (point) => (
              <li key={point} className="flex gap-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
                <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--positive)]" aria-hidden="true" />
                {point}
              </li>
            ),
          )}
        </ul>
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
              // Phone keyboards otherwise capitalise and autocorrect an address.
              inputMode="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="you@example.com"
              required
              autoFocus
            />
          )}
        </Field>

        <Field label={t('password')}>
          {(props) => (
            <>
              <div className="relative">
                <Input
                  {...props}
                  type={reveal ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  className="pr-10"
                  required
                />
                {/* Typing twelve characters blind on a phone is where people give up. */}
                <button
                  type="button"
                  onClick={() => setReveal((shown) => !shown)}
                  aria-label={reveal ? t('register.hidePassword') : t('register.showPassword')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-[var(--radius-sm)] p-1.5 text-[var(--text-subtle)] hover:text-[var(--text)]"
                >
                  {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
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

        {/* Honeypot: off-screen, out of the tab order and hidden from assistive
            tech. People never see it; form-filling scripts complete it. */}
        <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label>
            {t('register.honeypot')}
            <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
          </label>
        </div>

        {turnstileSiteKey ? (
          <>
            <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
            <div className="cf-turnstile" data-sitekey={turnstileSiteKey} data-theme="auto" />
          </>
        ) : null}

        <Button type="submit" variant="primary" block loading={pending} disabled={!longEnough}>
          {t('register.submit')}
        </Button>

        <p className="text-center text-[12px] leading-relaxed text-[var(--text-subtle)]">
          {t('register.noCard')}
        </p>
        <p className="text-center text-[11.5px] leading-relaxed text-[var(--text-subtle)]">
          {t('register.disclaimer')}
        </p>
      </form>
    </div>
  );
}
