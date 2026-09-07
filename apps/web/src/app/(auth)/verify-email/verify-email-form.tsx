'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, MailX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, Notice } from '@flt/ui';
import { ApiError, post } from '@/lib/api';

/**
 * Confirms an email address from the token in the link.
 *
 * Submits on load rather than asking for a click. The user already acted — they
 * clicked the link in their inbox — and a second "confirm your confirmation"
 * button is a step that exists only to make the page feel like a form.
 *
 * The one place that would be wrong is if the request were not idempotent, so
 * the guard below matters: React runs effects twice in development, and a
 * single-use token consumed by the first call would make the second report the
 * link as invalid on a page that had in fact just succeeded.
 */
type State = 'working' | 'done' | 'failed' | 'missing';

export function VerifyEmailForm({ token }: { token: string | null }) {
  const t = useTranslations('auth.verify');
  const [state, setState] = useState<State>(token ? 'working' : 'missing');
  const [message, setMessage] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    void (async () => {
      try {
        await post('/api/auth/verify-email', { token });
        setState('done');
      } catch (caught) {
        setState('failed');
        setMessage(caught instanceof ApiError ? caught.message : t('failedGenericError'));
      }
    })();
  }, [token]);

  if (state === 'missing') {
    return (
      <Shell
        icon={<MailX className="size-4 text-[var(--warning)]" />}
        title={t('incompleteTitle')}
        body={t('incompleteBody')}
      >
        <Button asChild variant="secondary" block>
          <Link href="/login">{t('goToSignIn')}</Link>
        </Button>
      </Shell>
    );
  }

  if (state === 'working') {
    return <Shell title={t('workingTitle')} body={t('workingBody')} />;
  }

  if (state === 'failed') {
    return (
      <Shell
        icon={<MailX className="size-4 text-[var(--negative)]" />}
        title={t('failedTitle')}
        body={t('failedBody')}
      >
        {message ? <Notice tone="negative">{message}</Notice> : null}
        <Button asChild variant="primary" block>
          <Link href="/login">{t('goToSignIn')}</Link>
        </Button>
      </Shell>
    );
  }

  return (
    <Shell
      icon={<CheckCircle2 className="size-4 text-[var(--positive)]" />}
      title={t('doneTitle')}
      body={t('doneBody')}
    >
      <Button asChild variant="primary" block>
        <Link href="/login">{t('signIn')}</Link>
      </Button>
    </Shell>
  );
}

function Shell({
  icon,
  title,
  body,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="animate-fade-up space-y-4">
      <header>
        {icon ? (
          <div className="mb-3 flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-raised)]">
            {icon}
          </div>
        ) : null}
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-[var(--text)]">{title}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">{body}</p>
      </header>
      {children}
    </div>
  );
}
