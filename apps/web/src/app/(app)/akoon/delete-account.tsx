'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Notice } from '@flt/ui';
import { ApiError, post } from '@/lib/api';

/**
 * "Delete my account", in the app — the path Google Play requires.
 *
 * The blockers are worked out on the server so the person sees what to close
 * before they try. Confirmation needs the word DELETE typed, because the
 * request signs them out everywhere the moment it succeeds.
 */
export function DeleteAccount({ blockers }: { blockers: string[] }) {
  const t = useTranslations('deleteAccount');
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await post('/api/account/deletion', {});
      window.location.assign('/delete-account?requested=1');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('error'));
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {blockers.length > 0 ? (
          <Notice tone="warning">
            <p>{t('blockedIntro')}</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
              {blockers.map((blocker) => (
                <li key={blocker}>{t(`blockers.${blocker}` as 'blockers.balance')}</li>
              ))}
            </ul>
          </Notice>
        ) : null}

        {error ? <Notice tone="negative">{error}</Notice> : null}

        {!open ? (
          <Button variant="danger" disabled={blockers.length > 0} onClick={() => setOpen(true)}>
            {t('cta')}
          </Button>
        ) : (
          <div className="space-y-2">
            <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">{t('confirmBody')}</p>
            <Input
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder="DELETE"
              aria-label={t('confirmLabel')}
            />
            <div className="flex gap-2">
              <Button
                variant="danger"
                disabled={confirmText.trim() !== 'DELETE' || busy}
                loading={busy}
                onClick={() => void submit()}
              >
                {t('confirmCta')}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
                {t('cancel')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
