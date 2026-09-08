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
 *
 * Fields collected here mirror the required-information list in the AML/CFT
 * Procedures (P-01): identity, residence, occupation, purpose, and expected
 * activity. This is a duplicate, deliberately small list — kept in sync by
 * hand with `HIGH_RISK_KYC_COUNTRIES` in `@flt/core/services/kyc`, which a
 * client component cannot import directly since that module pulls in the
 * Prisma client. Its only job here is knowing when to show the
 * source-of-funds field before a round trip tells the user it's required.
 */
const HIGH_RISK_COUNTRY_CODES = new Set(['KP', 'IR', 'MM', 'AF', 'SY']);

const VOLUME_BANDS = [
  'Under $1,000/month',
  '$1,000–$5,000/month',
  '$5,000–$25,000/month',
  '$25,000–$100,000/month',
  'Over $100,000/month',
];

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
  const [residenceAddress, setResidenceAddress] = useState('');
  const [occupation, setOccupation] = useState('');
  const [accountPurpose, setAccountPurpose] = useState('');
  const [expectedMonthlyVolume, setExpectedMonthlyVolume] = useState('');
  const [isPoliticallyExposed, setIsPoliticallyExposed] = useState(false);
  const [pepDetails, setPepDetails] = useState('');
  const [sourceOfFundsEvidence, setSourceOfFundsEvidence] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const eddLikely = isPoliticallyExposed || HIGH_RISK_COUNTRY_CODES.has(countryCode.toUpperCase());

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
        residenceAddress,
        occupation,
        accountPurpose,
        expectedMonthlyVolume,
        isPoliticallyExposed,
        pepDetails: isPoliticallyExposed ? pepDetails : undefined,
        sourceOfFundsEvidence: eddLikely ? sourceOfFundsEvidence : undefined,
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

          <Field label={t('residenceAddress')} description={t('residenceAddressHint')} required>
            {(props) => (
              <Input
                {...props}
                value={residenceAddress}
                onChange={(event) => setResidenceAddress(event.target.value)}
                autoComplete="street-address"
                required
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('occupation')} required>
              {(props) => (
                <Input
                  {...props}
                  value={occupation}
                  onChange={(event) => setOccupation(event.target.value)}
                  autoComplete="organization-title"
                  required
                />
              )}
            </Field>

            <Field label={t('expectedMonthlyVolume')} required>
              {(props) => (
                <select
                  {...props}
                  value={expectedMonthlyVolume}
                  onChange={(event) => setExpectedMonthlyVolume(event.target.value)}
                  required
                  className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[13px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
                >
                  <option value="" disabled>
                    {t('selectOne')}
                  </option>
                  {VOLUME_BANDS.map((band) => (
                    <option key={band} value={band}>
                      {band}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          <Field label={t('accountPurpose')} description={t('accountPurposeHint')} required>
            {(props) => (
              <Input
                {...props}
                value={accountPurpose}
                onChange={(event) => setAccountPurpose(event.target.value)}
                required
              />
            )}
          </Field>

          <label className="flex cursor-pointer items-start gap-2 rounded-[var(--radius)] border border-[var(--border)] p-2.5 text-[12px] text-[var(--text)] hover:border-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={isPoliticallyExposed}
              onChange={(event) => setIsPoliticallyExposed(event.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-[var(--text)]"
            />
            <span>{t('pepQuestion')}</span>
          </label>

          {isPoliticallyExposed ? (
            <Field label={t('pepDetails')} description={t('pepDetailsHint')} required>
              {(props) => (
                <Input
                  {...props}
                  value={pepDetails}
                  onChange={(event) => setPepDetails(event.target.value)}
                  required
                />
              )}
            </Field>
          ) : null}

          {eddLikely ? (
            <Field label={t('sourceOfFunds')} description={t('sourceOfFundsHint')} required>
              {(props) => (
                <Input
                  {...props}
                  value={sourceOfFundsEvidence}
                  onChange={(event) => setSourceOfFundsEvidence(event.target.value)}
                  required
                />
              )}
            </Field>
          ) : null}

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
