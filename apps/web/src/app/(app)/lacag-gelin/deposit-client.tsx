'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  ArrowUpRight,
  Check,
  Clock,
  Copy,
  Smartphone,
  Wallet,
  X,
  Landmark,
  Mail,
} from 'lucide-react';
import {
  AddressChip,
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

/**
 * Adding money — two ways, kept simple.
 *
 * **Crypto.** Send USDC or USDT on Base to your own FLT address; the balance is
 * credited once we have confirmed it on-chain.
 *
 * **EVC (mobile money).** Pay by EVC Plus USSD to FLT's merchant number — your
 * phone shows the name FTL-IT on the prompt — then tell us the number you paid
 * from and the amount, and we match it to your payment.
 *
 * Nothing here credits anything by itself: a crypto deposit is credited on a
 * mined receipt, and an EVC payment when an operator has seen it on the
 * statement. The copy says so, because a participant who expects an instant
 * balance will otherwise conclude the platform lost their money.
 */
export function DepositClient({
  available,
  minUsd,
  feeBps,
  walletAddress,
  explorerUrl,
  evcMerchantNumber,
  wire,
  paypal,
  history,
}: {
  available: boolean;
  minUsd: string;
  feeBps: number;
  walletAddress: string;
  explorerUrl?: string;
  evcMerchantNumber: string;
  /** Where to wire, as the operator set it. Closed unless its details are complete. */
  wire: {
    enabled: boolean;
    bankName: string;
    accountName: string;
    accountNumber: string;
    routingNumber: string;
    swift: string;
    bankAddress: string;
  };
  /** The PayPal address to pay, as the operator set it. */
  paypal: { enabled: boolean; address: string };
  history: HistoryRow[];
}) {
  const t = useTranslations('deposit');

  const [tab, setTab] = useState<'crypto' | 'fiat' | 'wire' | 'paypal'>('crypto');
  const [payerName, setPayerName] = useState('');
  const [payerEmail, setPayerEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [issued, setIssued] = useState<Instructions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'address' | 'reference' | null>(null);

  const amountNumber = Number(amount);
  const belowMinimum = Boolean(amount) && amountNumber < Number(minUsd);
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
        await post<Instructions>(
          '/api/deposits',
          tab === 'wire'
            ? { method: 'WIRE', amountFiat: amount.trim(), payerName: payerName.trim() }
            : tab === 'paypal'
              ? { method: 'PAYPAL', amountFiat: amount.trim(), payerEmail: payerEmail.trim() }
              : { method: 'EVC', amountFiat: amount.trim(), payerPhone: phone.trim() },
        ),
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  async function copy(what: 'address' | 'reference') {
    const value = what === 'address' ? walletAddress : issued?.reference;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 2_000);
    } catch {
      // On screen and selectable; this is a convenience.
    }
  }

  const tabButton = (key: 'crypto' | 'fiat' | 'wire' | 'paypal', icon: React.ReactNode, label: string) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      aria-pressed={tab === key}
      className={
        'flex items-center justify-center gap-2 rounded-[var(--radius-md)] border px-3 py-2.5 text-[13px] font-medium transition-colors ' +
        (tab === key
          ? 'border-[var(--text)] bg-[var(--surface-raised)] text-[var(--text)]'
          : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]')
      }
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="mx-auto w-full max-w-lg space-y-4">
      <div
        className={
          'grid gap-2 ' +
          (wire.enabled && paypal.enabled ? 'grid-cols-2 sm:grid-cols-4' : wire.enabled || paypal.enabled ? 'grid-cols-3' : 'grid-cols-2')
        }
      >
        {tabButton('crypto', <Wallet className="size-4" />, t('cryptoOption'))}
        {tabButton('fiat', <Smartphone className="size-4" />, t('fiatOption'))}
        {wire.enabled ? tabButton('wire', <Landmark className="size-4" />, t('wireOption')) : null}
        {paypal.enabled ? tabButton('paypal', <Mail className="size-4" />, t('paypalOption')) : null}
      </div>

      {tab === 'crypto' ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('cryptoTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">{t('cryptoIntro')}</p>

            <div className="rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-sunken)] p-4">
              <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                {t('yourAddress')}
              </p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <AddressChip address={walletAddress} explorerUrl={explorerUrl} />
                <Button variant="secondary" size="sm" onClick={() => void copy('address')}>
                  {copied === 'address' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied === 'address' ? t('copied') : t('copy')}
                </Button>
              </div>
            </div>

            <Notice tone="info" title={t('cryptoNoticeTitle')}>
              {t('cryptoNotice')}
            </Notice>
          </CardContent>
        </Card>
      ) : issued ? (
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

            <Button variant="secondary" size="sm" block onClick={() => void copy('reference')}>
              {copied === 'reference' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied === 'reference' ? t('copied') : t('copyReference')}
            </Button>

            <div className="divide-y divide-[var(--border)]">
              <DetailRow label={t('amount')} value={`${issued.amountFiat} ${issued.currency}`} emphasis />
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

            {issued.method === 'WIRE' ? (
              <div className="space-y-1 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-sunken)] p-4 text-[13px]">
                <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">{t('bankDetailsTitle')}</p>
                <DetailRow label={t('bankName')} value={wire.bankName} />
                <DetailRow label={t('accountName')} value={wire.accountName} />
                <DetailRow label={t('accountNumber')} value={wire.accountNumber} />
                {wire.routingNumber ? <DetailRow label={t('routingNumber')} value={wire.routingNumber} /> : null}
                {wire.swift ? <DetailRow label={t('swift')} value={wire.swift} /> : null}
                {wire.bankAddress ? <DetailRow label={t('bankAddress')} value={wire.bankAddress} /> : null}
                <p className="pt-1 text-[12px] text-[var(--text-muted)]">{t('putReference')}</p>
              </div>
            ) : null}

            {issued.method === 'PAYPAL' ? (
              <div className="rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-sunken)] p-4 text-center">
                <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">{t('paypalSendTo')}</p>
                <p className="mt-1 select-all break-all text-[16px] font-semibold text-[var(--text)]">{paypal.address}</p>
                <p className="pt-2 text-[12px] text-[var(--text-muted)]">{t('putReference')}</p>
              </div>
            ) : null}

            <Notice tone="warning" icon={<Clock className="size-4" />} title={t('pendingTitle')}>
              {t('pendingBody')}
            </Notice>

            <p className="text-center text-[11.5px] leading-relaxed text-[var(--text-subtle)]">{t('supportNote')}</p>

            <Button variant="ghost" size="sm" block onClick={() => setIssued(null)}>
              {t('backToForm')}
            </Button>
          </CardContent>
        </Card>
      ) : tab === 'wire' || tab === 'paypal' ? (
        <Card>
          <CardHeader>
            <CardTitle>{tab === 'wire' ? t('wireTitle') : t('paypalTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!available ? (
              <Notice tone="warning" title={t('unavailableTitle')}>
                {t('unavailableBody')}
              </Notice>
            ) : null}

            <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">
              {tab === 'wire' ? t('wireIntro') : t('paypalIntro')}
            </p>

            {error ? <Notice tone="negative">{error}</Notice> : null}

            {tab === 'wire' ? (
              <Field label={t('payerNameLabel')} description={t('payerNameHint')}>
                {(props) => (
                  <Input {...props} value={payerName} onChange={(event) => setPayerName(event.target.value)} autoComplete="name" />
                )}
              </Field>
            ) : (
              <Field label={t('payerEmailLabel')} description={t('payerEmailHint')}>
                {(props) => (
                  <Input
                    {...props}
                    type="email"
                    inputMode="email"
                    value={payerEmail}
                    onChange={(event) => setPayerEmail(event.target.value)}
                    autoComplete="email"
                  />
                )}
              </Field>
            )}

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
                (tab === 'wire'
                  ? payerName.trim().length < 2
                  : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail.trim()))
              }
              onClick={() => void submit()}
            >
              {t('getReference')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('fiatTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!available ? (
              <Notice tone="warning" title={t('unavailableTitle')}>
                {t('unavailableBody')}
              </Notice>
            ) : null}

            <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">{t('fiatIntro')}</p>

            <ol className="ml-1 list-decimal space-y-1.5 pl-4 text-[13px] leading-relaxed text-[var(--text-muted)]">
              <li>{t('evcStep1', { merchant: evcMerchantNumber })}</li>
              <li>{t('evcStep2')}</li>
            </ol>

            <Notice tone="info" icon={<Smartphone className="size-4" />}>
              {t('evcPrompt')}
            </Notice>

            {error ? <Notice tone="negative">{error}</Notice> : null}

            <Field label={t('payerPhone')} description={t('payerPhoneHint')}>
              {(props) => (
                <Input
                  {...props}
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
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
              disabled={!available || !amount || belowMinimum || phone.trim().length < 7}
              onClick={() => void submit()}
            >
              {t('getReference')}
            </Button>
          </CardContent>
        </Card>
      )}

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

      <Card>
        <CardHeader>
          <CardTitle>{t('withdrawGuideTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3.5">
          <ol className="ml-1 list-decimal space-y-1.5 pl-4 text-[13px] leading-relaxed text-[var(--text-muted)]">
            <li>{t('withdrawStep1')}</li>
            <li>{t('withdrawStep2')}</li>
          </ol>
          <Button asChild variant="secondary" size="sm">
            <Link href="/lacag-qaadasho">
              {t('goToWithdraw')}
              <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
