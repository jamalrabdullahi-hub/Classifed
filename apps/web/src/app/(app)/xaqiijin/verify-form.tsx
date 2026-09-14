'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Clock, ShieldCheck, XCircle } from 'lucide-react';
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
  cn,
} from '@flt/ui';
import { ApiError, post } from '@/lib/api';

/**
 * Identity verification — four steps.
 *
 *   1. Identity  — legal name, date of birth, nationality, residence.
 *   2. Address   — residential address + phone.
 *   3. Document  — identity document type, issuing country, number, photo.
 *   4. Risk      — occupation, purpose, expected volume, PEP (EDD if high-risk).
 *
 * The field set is the union of the US (BSA/CIP) and Somalia (FGS/CBS)
 * requirements — see `@flt/core/services/kyc-jurisdiction`. It is duplicated
 * here (like HIGH_RISK_COUNTRY_CODES) because a client component cannot import
 * a server module that pulls in Prisma; its only job client-side is validating
 * a step before advancing, so a mistake here costs a round trip, not a
 * compliance gap (the server re-validates the union).
 *
 * The document photo is resized in the browser before upload so it fits behind
 * the proxy's 1 MB request cap and stays cheap to store; the server encrypts it
 * at rest. The copy stays plain: a person reviews the submission.
 */
const HIGH_RISK_COUNTRY_CODES = new Set(['KP', 'IR', 'MM', 'AF', 'SY']);

const VOLUME_BANDS = [
  'Under $1,000/month',
  '$1,000–$5,000/month',
  '$5,000–$25,000/month',
  '$25,000–$100,000/month',
  'Over $100,000/month',
];

const ID_TYPES = ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENSE'] as const;

/** Resize an image client-side; pass a PDF straight through. */
async function prepareUpload(
  file: File,
): Promise<{ dataBase64: string; mimeType: 'image/jpeg' | 'application/pdf' }> {
  if (file.type === 'application/pdf') {
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 1) { const byte = buffer[i]; binary += String.fromCharCode(byte === undefined ? 0 : byte); }
    return { dataBase64: btoa(binary), mimeType: 'application/pdf' };
  }

  const bitmap = await createImageBitmap(file);
  const maxDimension = 1600;
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  const comma = dataUrl.indexOf(',');
  return { dataBase64: dataUrl.slice(comma + 1), mimeType: 'image/jpeg' };
}

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

  const [step, setStep] = useState(1);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [nationalityCode, setNationalityCode] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [residenceAddress, setResidenceAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [idType, setIdType] = useState<(typeof ID_TYPES)[number]>('PASSPORT');
  const [idCountry, setIdCountry] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [occupation, setOccupation] = useState('');
  const [accountPurpose, setAccountPurpose] = useState('');
  const [expectedMonthlyVolume, setExpectedMonthlyVolume] = useState('');
  const [isPoliticallyExposed, setIsPoliticallyExposed] = useState(false);
  const [pepDetails, setPepDetails] = useState('');
  const [sourceOfFundsEvidence, setSourceOfFundsEvidence] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const eddLikely = isPoliticallyExposed || HIGH_RISK_COUNTRY_CODES.has(countryCode.toUpperCase());

  const stepValid = [
    firstName.trim().length > 0 &&
      lastName.trim().length > 0 &&
      Boolean(dateOfBirth) &&
      nationalityCode.trim().length === 2 &&
      countryCode.trim().length === 2,
    residenceAddress.trim().length >= 5 && phone.trim().length >= 7,
    idCountry.trim().length === 2 && idNumber.trim().length >= 3 && documentId !== null,
    occupation.trim().length >= 2 &&
      accountPurpose.trim().length >= 5 &&
      Boolean(expectedMonthlyVolume) &&
      (!isPoliticallyExposed || pepDetails.trim().length >= 10) &&
      (!eddLikely || sourceOfFundsEvidence.trim().length >= 20),
  ];
  const canAdvance = stepValid[step - 1];

  async function onFile(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadError(null);
    setUploading(true);
    try {
      const file = files[0];
      if (!file) return;
      const prepared = await prepareUpload(file);
      const result = await post<{ id: string }>('/api/kyc/document', {
        documentType: idType,
        mimeType: prepared.mimeType,
        dataBase64: prepared.dataBase64,
      });
      setDocumentId(result.id);
    } catch (caught) {
      setUploadError(caught instanceof ApiError ? caught.message : t('uploadFailed'));
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    setError(null);
    setPending(true);
    try {
      await post('/api/kyc', {
        legalFirstName: firstName,
        legalLastName: lastName,
        dateOfBirth,
        nationalityCode: nationalityCode.toUpperCase(),
        countryCode: countryCode.toUpperCase(),
        residenceAddress,
        phone,
        idType,
        idCountry: idCountry.toUpperCase(),
        idNumber,
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

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (step < 4) {
      if (canAdvance) setStep(step + 1);
      return;
    }
    void submit();
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

  const selectClass =
    'w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[13px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]';

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

        <div className="mb-5 flex items-center gap-2" aria-hidden="true">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="flex flex-1 items-center gap-2">
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                  s < step
                    ? 'border-[var(--positive-border)] bg-[var(--positive-subtle)] text-[var(--positive)]'
                    : s === step
                      ? 'border-[var(--text)] text-[var(--text)]'
                      : 'border-[var(--border)] text-[var(--text-subtle)]',
                )}
              >
                {s < step ? <Check className="size-3" /> : s}
              </span>
              {s < 4 ? (
                <span className={cn('h-px flex-1', s < step ? 'bg-[var(--positive-border)]' : 'bg-[var(--border)]')} />
              ) : null}
            </div>
          ))}
        </div>

        <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-subtle)]">
          {t('stepOf', { current: step, total: 4 })} · {t(`stepTitle${step}` as 'stepTitle1')}
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          {error ? <Notice tone="negative">{error}</Notice> : null}

          {step === 1 ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('legalFirstName')} required>
                  {(props) => (
                    <Input {...props} value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" required />
                  )}
                </Field>
                <Field label={t('legalLastName')} required>
                  {(props) => (
                    <Input {...props} value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" required />
                  )}
                </Field>
              </div>
              <Field label={t('dateOfBirth')} description={t('dateOfBirthHint')} required>
                {(props) => (
                  <Input {...props} type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} autoComplete="bday" required />
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('nationality')} description={t('nationalityHint')} required>
                  {(props) => (
                    <Input
                      {...props}
                      value={nationalityCode}
                      onChange={(e) => setNationalityCode(e.target.value.toUpperCase().slice(0, 2))}
                      maxLength={2}
                      autoComplete="country"
                      className="uppercase"
                      required
                    />
                  )}
                </Field>
                <Field label={t('countryOfResidence')} description={t('countryHint')} required>
                  {(props) => (
                    <Input
                      {...props}
                      value={countryCode}
                      onChange={(e) => setCountryCode(e.target.value.toUpperCase().slice(0, 2))}
                      maxLength={2}
                      autoComplete="country"
                      className="uppercase"
                      required
                    />
                  )}
                </Field>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <Field label={t('residenceAddress')} description={t('residenceAddressHint')} required>
                {(props) => (
                  <Input {...props} value={residenceAddress} onChange={(e) => setResidenceAddress(e.target.value)} autoComplete="street-address" required />
                )}
              </Field>
              <Field label={t('phone')} description={t('phoneHint')} required>
                {(props) => (
                  <Input
                    {...props}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="+252 6x xxx xxxx"
                    className="num"
                    required
                  />
                )}
              </Field>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <Field label={t('idType')} required>
                {(props) => (
                  <select
                    {...props}
                    value={idType}
                    onChange={(e) => setIdType(e.target.value as typeof idType)}
                    required
                    className={selectClass}
                  >
                    {ID_TYPES.map((entry) => (
                      <option key={entry} value={entry}>
                        {t(`idType.${entry}` as 'idType.PASSPORT')}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={t('idCountry')} description={t('idCountryHint')} required>
                {(props) => (
                  <Input
                    {...props}
                    value={idCountry}
                    onChange={(e) => setIdCountry(e.target.value.toUpperCase().slice(0, 2))}
                    maxLength={2}
                    className="uppercase"
                    required
                  />
                )}
              </Field>
              <Field label={t('idNumber')} description={t('idNumberHint')} required>
                {(props) => (
                  <Input {...props} value={idNumber} onChange={(e) => setIdNumber(e.target.value)} className="num" required />
                )}
              </Field>

              <div className="rounded-[var(--radius)] border border-[var(--border)] p-3">
                <p className="text-[12px] font-medium text-[var(--text)]">{t('uploadTitle')}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-subtle)]">{t('uploadHint')}</p>
                <input
                  type="file"
                  accept="image/jpeg,image/png,application/pdf"
                  className="mt-2 block w-full text-[12px] text-[var(--text-muted)]"
                  onChange={(e) => void onFile(e.target.files)}
                />
                {uploading ? (
                  <p className="mt-2 text-[12px] text-[var(--text-muted)]">{t('uploading')}</p>
                ) : null}
                {documentId && !uploading ? (
                  <p className="mt-2 flex items-center gap-1 text-[12px] text-[var(--positive)]">
                    <Check className="size-3.5" /> {t('uploaded')}
                  </p>
                ) : null}
                {uploadError ? <p className="mt-2 text-[12px] text-[var(--negative)]">{uploadError}</p> : null}
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('occupation')} required>
                  {(props) => (
                    <Input {...props} value={occupation} onChange={(e) => setOccupation(e.target.value)} autoComplete="organization-title" required />
                  )}
                </Field>
                <Field label={t('expectedMonthlyVolume')} required>
                  {(props) => (
                    <select
                      {...props}
                      value={expectedMonthlyVolume}
                      onChange={(e) => setExpectedMonthlyVolume(e.target.value)}
                      required
                      className={selectClass}
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
                  <Input {...props} value={accountPurpose} onChange={(e) => setAccountPurpose(e.target.value)} required />
                )}
              </Field>
              <label className="flex cursor-pointer items-start gap-2 rounded-[var(--radius)] border border-[var(--border)] p-2.5 text-[12px] text-[var(--text)] hover:border-[var(--text-muted)]">
                <input
                  type="checkbox"
                  checked={isPoliticallyExposed}
                  onChange={(e) => setIsPoliticallyExposed(e.target.checked)}
                  className="mt-0.5 size-3.5 shrink-0 accent-[var(--text)]"
                />
                <span>{t('pepQuestion')}</span>
              </label>
              {isPoliticallyExposed ? (
                <Field label={t('pepDetails')} description={t('pepDetailsHint')} required>
                  {(props) => (
                    <Input {...props} value={pepDetails} onChange={(e) => setPepDetails(e.target.value)} required />
                  )}
                </Field>
              ) : null}
              {eddLikely ? (
                <Field label={t('sourceOfFunds')} description={t('sourceOfFundsHint')} required>
                  {(props) => (
                    <Input {...props} value={sourceOfFundsEvidence} onChange={(e) => setSourceOfFundsEvidence(e.target.value)} required />
                  )}
                </Field>
              ) : null}
            </>
          ) : null}

          <div className="flex items-center gap-2 pt-1">
            {step > 1 ? (
              <Button type="button" variant="secondary" onClick={() => setStep(step - 1)}>
                <ArrowLeft className="size-3.5" />
                {t('back')}
              </Button>
            ) : null}
            {step < 4 ? (
              // Distinct keys: without them React reuses this <button> for the
              // submit button on step 4 and flips its type mid-click, which
              // submits an empty final step the moment you press Next.
              <Button key="next" type="button" variant="primary" block disabled={!canAdvance} onClick={() => setStep(step + 1)}>
                {t('next')}
                <ArrowRight className="size-3.5" />
              </Button>
            ) : (
              <Button key="submit" type="submit" variant="primary" block loading={pending} disabled={!canAdvance}>
                {t('submitForReview')}
              </Button>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">{t('footerNote')}</p>
        </form>
      </CardContent>
    </Card>
  );
}
