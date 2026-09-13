'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Banknote } from 'lucide-react';
import {
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
  cn,
} from '@flt/ui';
import { ApiError, post } from '@/lib/api';

type Method = 'EVC' | 'BANK' | 'PAYPAL';

interface HistoryRow {
  id: string;
  reference: string;
  method: string;
  amountUsd: string;
  netUsd: string;
  status: string;
  note: string | null;
  createdAt: string;
}

/**
 * Taking a USD balance out as cash.
 *
 * The money arrives from a person, not a smart contract, so the screen is honest
 * about timing and about the fee: the amount received is stated before the
 * request is sent, and the request says it is waiting for an operator rather
 * than implying it has already been paid.
 *
 * Card is shown as unavailable rather than left out, so its absence reads as a
 * decision rather than an oversight.
 */
export function FiatWithdrawForm({
  settings,
  availableUsd,
  history,
}: {
  settings: { enabled: boolean; feeBps: number; minUsd: string; evc: boolean; bank: boolean; paypal: boolean };
  availableUsd: string;
  history: HistoryRow[];
}) {
  const t = useTranslations('fiatWithdraw');
  const router = useRouter();

  const methods = (['EVC', 'BANK', 'PAYPAL'] as const).filter(
    (method) => ({ EVC: settings.evc, BANK: settings.bank, PAYPAL: settings.paypal })[method],
  );

  const [method, setMethod] = useState<Method>(methods[0] ?? 'EVC');
  const [amount, setAmount] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [bankName, setBankName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [routingNumber, setRoutingNumber] = useState('');
  const [swift, setSwift] = useState('');
  const [country, setCountry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);

  const amountNumber = Number(amount);
  const fee = Number.isFinite(amountNumber) ? Math.ceil(amountNumber * settings.feeBps) / 10_000 / 1 : 0;
  const feeRounded = Math.ceil(fee * 100) / 100;
  const net = Math.max(0, amountNumber - feeRounded);
  const belowMinimum = Boolean(amount) && amountNumber < Number(settings.minUsd);
  const overBalance = Boolean(amount) && amountNumber > Number(availableUsd);

  const destinationReady =
    payeeName.trim().length >= 2 &&
    (method === 'EVC'
      ? phone.replace(/\D/g, '').length >= 7
      : method === 'PAYPAL'
        ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
        : bankName.trim().length >= 2 && accountNumber.replace(/\s+/g, '').length >= 4);

  async function submit() {
    setError(null);
    setSubmitted(null);
    setBusy(true);
    try {
      const result = await post<{ reference: string }>('/api/withdrawals/fiat', {
        method,
        amountUsd: amount.trim(),
        payeeName: payeeName.trim(),
        ...(method === 'EVC' ? { payeePhone: phone.trim() } : {}),
        ...(method === 'PAYPAL' ? { payeeEmail: email.trim() } : {}),
        ...(method === 'BANK'
          ? {
              bankName: bankName.trim(),
              accountNumber: accountNumber.trim(),
              routingNumber: routingNumber.trim() || undefined,
              swift: swift.trim() || undefined,
              country: country.trim() || undefined,
            }
          : {}),
      });
      setSubmitted(result.reference);
      setAmount('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  if (!settings.enabled || methods.length === 0) {
    return (
      <Notice tone="info" title={t('unavailableTitle')}>
        {t('unavailableBody')}
      </Notice>
    );
  }

  const text = (label: string, value: string, onChange: (next: string) => void, extra?: Record<string, unknown>) => (
    <Field label={label}>
      {(props) => <Input {...props} {...extra} value={value} onChange={(event) => onChange(event.target.value)} />}
    </Field>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('formTitle')}</CardTitle>
          <Banknote className="size-4 text-[var(--text-subtle)]" />
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <Notice tone="negative">{error}</Notice> : null}
          {submitted ? <Notice tone="positive">{t('submitted', { reference: submitted })}</Notice> : null}

          <div className="grid grid-cols-4 gap-1.5">
            {methods.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMethod(option)}
                aria-pressed={method === option}
                className={cn(
                  'rounded-[var(--radius)] border px-2 py-2 text-[12px] transition-colors',
                  method === option
                    ? 'border-[var(--text)] bg-[var(--surface-raised)] text-[var(--text)]'
                    : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]',
                )}
              >
                {t(`method_${option}`)}
              </button>
            ))}
            <span
              className="flex cursor-not-allowed items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--border)] px-2 py-2 text-[12px] text-[var(--text-subtle)]"
              title={t('cardUnavailable')}
            >
              {t('method_CARD')}
            </span>
          </div>

          <Field label={t('amountLabel')} description={t('availableLine', { amount: availableUsd, min: settings.minUsd })}>
            {(props) => (
              <Input
                {...props}
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                placeholder="100"
                className="num"
              />
            )}
          </Field>

          {amount && !belowMinimum && !overBalance ? (
            <div className="divide-y divide-[var(--border)]">
              <DetailRow label={t('feeLine', { pct: (settings.feeBps / 100).toFixed(2) })} value={`$${feeRounded.toFixed(2)}`} />
              <DetailRow label={t('youReceive')} value={`$${net.toFixed(2)}`} emphasis />
            </div>
          ) : null}
          {belowMinimum ? <Notice tone="warning">{t('belowMinimum', { min: settings.minUsd })}</Notice> : null}
          {overBalance ? <Notice tone="warning">{t('overBalance')}</Notice> : null}

          {text(t('payeeName'), payeeName, setPayeeName, { autoComplete: 'name' })}

          {method === 'EVC' ? text(t('phone'), phone, setPhone, { inputMode: 'tel', placeholder: '6xxxxxxx', className: 'num' }) : null}

          {method === 'PAYPAL' ? text(t('email'), email, setEmail, { inputMode: 'email', type: 'email' }) : null}

          {method === 'BANK' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {text(t('bankName'), bankName, setBankName)}
              {text(t('accountNumber'), accountNumber, setAccountNumber, { className: 'num' })}
              {text(t('routingNumber'), routingNumber, setRoutingNumber, { className: 'num' })}
              {text(t('swift'), swift, setSwift, { className: 'num' })}
              {text(t('country'), country, setCountry)}
            </div>
          ) : null}

          <Button
            variant="primary"
            block
            size="lg"
            loading={busy}
            disabled={!amount || belowMinimum || overBalance || !destinationReady || busy}
            onClick={() => void submit()}
          >
            {t('submit')}
          </Button>

          <p className="text-center text-[11.5px] leading-relaxed text-[var(--text-subtle)]">{t('timingNote')}</p>
        </CardContent>
      </Card>

      {history.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('historyTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {history.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="num text-[13px] text-[var(--text)]">
                    {row.reference} · ${row.netUsd} · {t(`method_${row.method}` as 'method_EVC')}
                  </p>
                  <p className="text-[11px] text-[var(--text-subtle)]">
                    {new Date(row.createdAt).toLocaleDateString()}
                    {row.note ? ` · ${row.note}` : ''}
                  </p>
                </div>
                <StatusPill tone={row.status === 'PAID' ? 'positive' : row.status === 'REJECTED' ? 'negative' : 'warning'}>
                  {t(`status_${row.status}` as 'status_REQUESTED')}
                </StatusPill>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
