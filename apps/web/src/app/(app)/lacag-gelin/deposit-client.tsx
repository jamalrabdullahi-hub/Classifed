'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Building2, Check, Clock, Copy, X } from 'lucide-react';
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
  reference: string;
  method: string;
  currency: string;
  amountFiat: string;
  netUsd: string | null;
  status: string;
  note: string | null;
  createdAt: string;
}

interface Instructions {
  reference: string;
  amountFiat: string;
  currency: string;
  method: string;
  /** Present for EVC: exactly what to dial. */
  ussdCode?: string | null;
}

const METHODS = ['ACH', 'WIRE', 'EVC', 'CASH'] as const;

/**
 * Requesting a deposit, and the reference that makes it findable.
 *
 * The reference is the whole mechanism: an operator matching a bank statement
 * has the participant's name and an amount, and neither is unique. Without a
 * code on the transfer, attributing money to an account is guesswork, and
 * guesswork about whose money this is has exactly one acceptable error rate.
 *
 * The screen is deliberate about the delay. Nothing here credits anything —
 * the balance appears when a person has seen the money and sent the crypto —
 * and somebody who transfers a thousand dollars expecting an instant balance
 * will otherwise conclude the platform lost it.
 */
export function DepositClient({
  available,
  minUsd,
  feeBps,
  instructions,
  walletAddress,
  history,
}: {
  available: boolean;
  minUsd: string;
  feeBps: number;
  instructions: string;
  walletAddress: string;
  history: HistoryRow[];
}) {
  const t = useTranslations('deposit');

  const [method, setMethod] = useState<(typeof METHODS)[number]>('EVC');
  const [amount, setAmount] = useState('');
  const [payerName, setPayerName] = useState('');
  const [payerPhone, setPayerPhone] = useState('');
  const [issued, setIssued] = useState<Instructions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const amountNumber = Number(amount);
  const belowMinimum = Boolean(amount) && amountNumber < Number(minUsd);
  // Shown before they commit, because a fee discovered afterwards reads as a
  // shortfall rather than a price.
  const estimatedFee = Number.isFinite(amountNumber)
    ? ((amountNumber * feeBps) / 10_000).toFixed(2)
    : '0.00';
  const estimatedNet = Number.isFinite(amountNumber)
    ? Math.max(0, amountNumber - Number(estimatedFee)).toFixed(2)
    : '0.00';

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      setIssued(
        await post<Instructions>('/api/deposits', {
          method,
          amountFiat: amount.trim(),
          payerName: payerName.trim(),
          payerPhone: payerPhone.trim(),
        }),
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  async function copyReference() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.reference);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // On screen and selectable; this is a convenience.
    }
  }

  if (issued) {
    return (
      <div className="mx-auto w-full max-w-lg space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('sendItTitle')}</CardTitle>
            <Badge tone="accent">{issued.method}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-sunken)] p-4 text-center">
              <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                {t('referenceLabel')}
              </p>
              <p className="num mt-1 select-all font-mono text-[22px] font-semibold text-[var(--text)]">
                {issued.reference}
              </p>
            </div>

            <Button variant="secondary" size="sm" block onClick={() => void copyReference()}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? t('copied') : t('copyReference')}
            </Button>

            <div className="divide-y divide-[var(--border)]">
              <DetailRow
                label={t('amount')}
                value={`${issued.amountFiat} ${issued.currency}`}
                emphasis
              />
            </div>

            {issued.ussdCode ? (
              <div className="rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-sunken)] p-4 text-center">
                <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                  {t('dialThis')}
                </p>
                <p className="num mt-1 select-all break-all font-mono text-[20px] font-semibold text-[var(--text)]">
                  {issued.ussdCode}
                </p>
              </div>
            ) : null}

            {instructions ? (
              <div className="rounded-[var(--radius-md)] border border-[var(--border)] p-3">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--text-subtle)]">
                  {t('whereToSend')}
                </p>
                {/* Whitespace preserved: an operator wrote this as an address
                    block, and reflowing it turns account numbers into prose. */}
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text)]">
                  {instructions}
                </p>
              </div>
            ) : null}

            <Notice tone="warning" icon={<Clock className="size-4" />} title={t('pendingTitle')}>
              {t('pendingBody')}
            </Notice>

            {/* The timeframe and a way to reach a person, on the screen they
                are looking at when they have just parted with money. */}
            <p className="text-center text-[11.5px] leading-relaxed text-[var(--text-subtle)]">
              {t('supportNote')}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('formTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">
            {t('intro', { address: `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` })}
          </p>

          {error ? <Notice tone="negative">{error}</Notice> : null}

          <Field label={t('method')}>
            {(props) => (
              <select
                {...props}
                value={method}
                onChange={(event) => setMethod(event.target.value as typeof method)}
                className="w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-transparent px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
              >
                {METHODS.map((entry) => (
                  <option key={entry} value={entry}>
                    {t(`methods.${entry}` as 'methods.ACH')}
                  </option>
                ))}
              </select>
            )}
          </Field>

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

          <Field label={t('amountLabel')} description={t('minimum', { min: minUsd })}>
            {(props) => (
              <Input
                {...props}
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                placeholder="1000"
                className="num"
              />
            )}
          </Field>

          {amount && !belowMinimum ? (
            <div className="divide-y divide-[var(--border)]">
              <DetailRow label={t('feeLabel', { pct: (feeBps / 100).toFixed(2) })} value={`$${estimatedFee}`} />
              <DetailRow label={t('youReceive')} value={`$${estimatedNet}`} emphasis />
            </div>
          ) : null}

          {belowMinimum ? <Notice tone="warning">{t('belowMinimum', { min: minUsd })}</Notice> : null}

          <Button
            variant="primary"
            block
            size="lg"
            loading={busy}
            disabled={
              !available ||
              !amount ||
              belowMinimum ||
              payerName.trim().length < 2 ||
              payerPhone.trim().length < 7
            }
            onClick={() => void submit()}
          >
            <Building2 className="size-4" />
            {t('getReference')}
          </Button>
        </CardContent>
      </Card>

      {history.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('yourDeposits')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {history.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="num text-[13px] text-[var(--text)]">
                    {row.reference} · {row.amountFiat} {row.currency}
                  </p>
                  <p className="text-[11px] text-[var(--text-subtle)]">
                    {new Date(row.createdAt).toLocaleDateString()}
                    {row.note ? ` · ${row.note}` : ''}
                  </p>
                </div>
                <StatusPill
                  tone={
                    row.status === 'DELIVERED'
                      ? 'positive'
                      : row.status === 'REJECTED'
                        ? 'negative'
                        : 'warning'
                  }
                >
                  {row.status === 'DELIVERED' ? (
                    <Check className="size-3" />
                  ) : row.status === 'REJECTED' ? (
                    <X className="size-3" />
                  ) : (
                    <Clock className="size-3" />
                  )}
                  {t(`status.${row.status}` as 'status.AWAITING_FUNDS')}
                </StatusPill>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
