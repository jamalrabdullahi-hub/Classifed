'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Clock, Copy, Phone, X } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DetailRow,
  Field,
  Input,
  Notice,
  StatusPill,
} from '@flt/ui';
import { ApiError, post } from '@/lib/api';

interface HistoryRow {
  id: string;
  tier: string;
  amountUsd: string;
  status: string;
  reviewNote: string | null;
  createdAt: string;
}

interface Prepared {
  paymentId: string;
  planName: string;
  amountUsd: string;
  ussdCode: string;
  merchantNumber: string;
  days: number;
}

/**
 * EVC Plus checkout.
 *
 * Two states and nothing clever between them: take the payer's details, then
 * show the code to dial. The code is deliberately shown *after* the record
 * exists, so a participant who dials and then closes the tab has still left
 * something an operator can find and honour.
 *
 * The screen says plainly, more than once, that dialling does not activate the
 * plan by itself. Somebody who has just sent real money and sees a success
 * screen will reasonably assume they are done; they are not, and the honest
 * thing is to say so before they pay rather than in a support reply afterwards.
 */
export function EvcCheckout({
  tier,
  planName,
  priceUsd,
  merchantNumber,
  available,
  defaultName,
  email,
  history,
}: {
  tier: string;
  planName: string;
  priceUsd: string;
  merchantNumber: string;
  available: boolean;
  defaultName: string;
  email: string;
  history: HistoryRow[];
}) {
  const t = useTranslations('checkout');

  const [payerName, setPayerName] = useState(defaultName);
  const [payerPhone, setPayerPhone] = useState('');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      setPrepared(await post<Prepared>('/api/checkout/evc', { tier, payerName, payerPhone }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!prepared) return;
    try {
      await navigator.clipboard.writeText(prepared.ussdCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access is refused in plenty of ordinary situations. The code
      // is on screen in full and selectable, so this is a convenience failing,
      // not the feature failing — nothing is reported.
    }
  }

  if (prepared) {
    return (
      <div className="mx-auto w-full max-w-lg space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('dialTitle')}</CardTitle>
            <Badge tone="accent">{prepared.planName}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-sunken)] p-4 text-center">
              <p className="num select-all break-all font-mono text-[22px] font-semibold tracking-[-0.01em] text-[var(--text)]">
                {prepared.ussdCode}
              </p>
            </div>

            <Button variant="secondary" size="sm" block onClick={() => void copyCode()}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? t('copied') : t('copyCode')}
            </Button>

            <div className="divide-y divide-[var(--border)]">
              <DetailRow label={t('amount')} value={`$${prepared.amountUsd}`} emphasis />
              <DetailRow label={t('merchant')} value={prepared.merchantNumber} />
              <DetailRow label={t('period')} value={t('days', { days: prepared.days })} />
            </div>

            {/* Localised here rather than shown from the server's `note`, which
                is written in English for logs and operators. */}
            <Notice tone="warning" icon={<Clock className="size-4" />} title={t('pendingTitle')}>
              {t('pendingBody')}
            </Notice>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{planName}</CardTitle>
          <Badge tone="accent">${priceUsd}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">
            {t('intro', { merchant: merchantNumber })}
          </p>

          {error ? <Notice tone="negative">{error}</Notice> : null}

          <Field label={t('payerName')} description={t('payerNameHint')}>
            {(props) => (
              <Input
                {...props}
                value={payerName}
                onChange={(event) => setPayerName(event.target.value)}
                autoComplete="name"
              />
            )}
          </Field>

          <Field label={t('payerPhone')} description={t('payerPhoneHint')}>
            {(props) => (
              <Input
                {...props}
                value={payerPhone}
                onChange={(event) => setPayerPhone(event.target.value)}
                inputMode="tel"
                autoComplete="tel"
                placeholder="6xxxxxxx"
                className="num"
              />
            )}
          </Field>

          <p className="text-[11px] text-[var(--text-subtle)]">{t('receiptTo', { email })}</p>

          <Button
            variant="primary"
            block
            size="lg"
            loading={busy}
            disabled={!available || payerName.trim().length < 2 || payerPhone.trim().length < 7}
            onClick={() => void submit()}
          >
            <Phone className="size-4" />
            {t('getCode')}
          </Button>
        </CardContent>
      </Card>

      {history.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('yourPayments')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {history.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-[13px] text-[var(--text)]">
                    {row.tier} — ${row.amountUsd}
                  </p>
                  <p className="text-[11px] text-[var(--text-subtle)]">
                    {new Date(row.createdAt).toLocaleDateString()}
                    {row.reviewNote ? ` · ${row.reviewNote}` : ''}
                  </p>
                </div>
                <StatusPill
                  tone={
                    row.status === 'CONFIRMED'
                      ? 'positive'
                      : row.status === 'REJECTED'
                        ? 'negative'
                        : 'warning'
                  }
                >
                  {row.status === 'CONFIRMED' ? (
                    <Check className="size-3" />
                  ) : row.status === 'REJECTED' ? (
                    <X className="size-3" />
                  ) : (
                    <Clock className="size-3" />
                  )}
                  {t(`status.${row.status}` as 'status.AWAITING_REVIEW')}
                </StatusPill>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
