'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Clock, ShieldCheck, XCircle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Notice,
} from '@flt/ui';
import { ApiError, post } from '@/lib/api';

/**
 * Identity verification.
 *
 * The copy is deliberately plain about what happens next: a person reviews the
 * submission. Phase 1 does not run automated checks, and implying that it does
 * would misrepresent how the decision is made.
 */
export function VerifyForm({
  status,
  rejectionReason,
  submittedAt,
}: {
  status: string;
  rejectionReason: string | null;
  submittedAt: string | null;
}) {
  const router = useRouter();
  const t = useTranslations('verifyForm');
  const locale = useLocale();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      await post('/api/kyc', {
        legalFirstName: firstName,
        legalLastName: lastName,
        dateOfBirth,
        countryCode: countryCode.toUpperCase(),
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('submitError'));
    } finally {
      setPending(false);
    }
  }

  if (status === 'APPROVED') {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="flex size-11 items-center justify-center rounded-full border border-[var(--positive-border)] bg-[var(--positive-subtle)]">
            <ShieldCheck className="size-5 text-[var(--positive)]" />
          </span>
          <div>
            <p className="text-sm font-semibold text-[var(--text)]">{t('verifiedTitle')}</p>
            <p className="mt-1 text-[13px] text-[var(--text-muted)]">{t('verifiedBody')}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status === 'IN_REVIEW' || status === 'PENDING') {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="flex size-11 items-center justify-center rounded-full border border-[var(--warning-border)] bg-[var(--warning-subtle)]">
            <Clock className="size-5 text-[var(--warning)]" />
          </span>
          <div className="max-w-sm">
            <p className="text-sm font-semibold text-[var(--text)]">{t('underReviewTitle')}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
              {t('underReviewBody')}
            </p>
            {submittedAt ? (
              <p className="mt-2 text-[11px] text-[var(--text-subtle)]">
                {t('submitted', { when: new Date(submittedAt).toLocaleString(locale) })}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t('verifyTitle')}</CardTitle>
          <CardDescription>{t('verifyDesc')}</CardDescription>
        </div>
      </CardHeader>

      <CardContent>
        {status === 'REJECTED' ? (
          <Notice tone="negative" icon={<XCircle className="size-4" />} className="mb-4">
            {rejectionReason ?? t('rejectedFallback')}
          </Notice>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-4">
          {error ? <Notice tone="negative">{error}</Notice> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('legalFirstName')} required>
              {(props) => (
                <Input
                  {...props}
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  autoComplete="given-name"
                  required
                />
              )}
            </Field>

            <Field label={t('legalLastName')} required>
              {(props) => (
                <Input
                  {...props}
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  autoComplete="family-name"
                  required
                />
              )}
            </Field>
          </div>

          <Field label={t('dateOfBirth')} description={t('dateOfBirthHint')} required>
            {(props) => (
              <Input
                {...props}
                type="date"
                value={dateOfBirth}
                onChange={(event) => setDateOfBirth(event.target.value)}
                autoComplete="bday"
                required
              />
            )}
          </Field>

          <Field
            label={t('countryOfResidence')}
            description={t('countryHint')}
            required
          >
            {(props) => (
              <Input
                {...props}
                value={countryCode}
                onChange={(event) => setCountryCode(event.target.value.toUpperCase().slice(0, 2))}
                maxLength={2}
                autoComplete="country"
                className="uppercase"
                required
              />
            )}
          </Field>

          <Button type="submit" variant="primary" block loading={pending}>
            {t('submitForReview')}
          </Button>

          <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">
            {t('footerNote')}
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
