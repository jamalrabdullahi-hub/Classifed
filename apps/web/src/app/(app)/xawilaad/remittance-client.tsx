'use client';

import { useEffect, useState } from 'react';
import { useAccount, useSendTransaction, useSwitchChain } from 'wagmi';
import { encodeFunctionData, erc20Abi } from 'viem';
import { useTranslations } from 'next-intl';
import { ArrowRight, Check, Clock, Send, X } from 'lucide-react';
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
import { ApiError, get, post, put } from '@/lib/api';

interface Terms {
  feeBps: number;
  fxRate: string;
  minUsd: string;
  maxUsd: string;
  currency: string;
}

interface HistoryRow {
  id: string;
  status: string;
  sendAmountUsd: string;
  payoutAmount: string;
  payoutCurrency: string;
  beneficiaryName: string;
  payoutReference: string | null;
  reviewNote: string | null;
  createdAt: string;
}

interface Quote {
  amountUsd: string;
  feeUsd: string;
  netUsd: string;
  fxRate: string;
  payoutAmount: string;
  payoutCurrency: string;
}

type Phase = 'form' | 'signing' | 'confirming' | 'sent';

/**
 * Sending money home.
 *
 * ## The payout is not instant, and the screen never implies it is
 *
 * EVC Plus gives FLT no way to send money programmatically, so the second leg
 * is a person paying out by hand. Someone who has just parted with real money
 * on behalf of a family member deserves to know that before they send, not
 * after — so the delay is stated on the form, again on the confirmation, and
 * the finished state says "being sent", never "sent".
 *
 * ## The recipient questions are not paperwork theatre
 *
 * The money lands on a phone belonging to somebody this platform has never
 * verified. The relationship and the purpose are what an operator reads before
 * releasing funds, so the labels ask for them plainly rather than dressing
 * them up as optional detail.
 */
export function RemittanceClient({
  terms,
  wallets,
  history,
}: {
  terms: Terms;
  wallets: { id: string; address: string; chainId: number }[];
  history: HistoryRow[];
}) {
  const t = useTranslations('remittance');
  const { isConnected, chainId } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();

  const [amountUsd, setAmountUsd] = useState('');
  const [beneficiaryName, setBeneficiaryName] = useState('');
  const [beneficiaryPhone, setBeneficiaryPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [purpose, setPurpose] = useState('');
  const [walletId, setWalletId] = useState(wallets[0]?.id ?? '');

  const [quote, setQuote] = useState<Quote | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Debounced quote while typing, so the payout figure tracks the amount
  // without a request per keystroke.
  useEffect(() => {
    if (!/^\d+(\.\d+)?$/.test(amountUsd)) {
      setQuote(null);
      return;
    }

    const timer = setTimeout(() => {
      void get<{ quote: Quote | null }>(
        `/api/remittance?amount=${encodeURIComponent(amountUsd)}`,
      )
        .then((data) => setQuote(data.quote))
        .catch(() => setQuote(null));
    }, 350);

    return () => clearTimeout(timer);
  }, [amountUsd]);

  const complete =
    quote !== null &&
    beneficiaryName.trim().length >= 2 &&
    beneficiaryPhone.trim().length >= 7 &&
    relationship.trim().length >= 2 &&
    purpose.trim().length >= 3 &&
    walletId !== '';

  async function send() {
    setError(null);
    setBusy(true);

    try {
      const prepared = await post<{
        orderId: string;
        transfer: { to: string; token: string; chainId: number; amountBaseUnits: string };
      }>('/api/remittance', {
        amountUsd,
        beneficiaryName,
        beneficiaryPhone,
        beneficiaryRelationship: relationship,
        purpose,
        walletId,
      });

      if (chainId !== prepared.transfer.chainId) {
        await switchChainAsync({ chainId: prepared.transfer.chainId as never });
      }

      setPhase('signing');
      const hash = await sendTransactionAsync({
        to: prepared.transfer.token as `0x${string}`,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [
            prepared.transfer.to as `0x${string}`,
            BigInt(prepared.transfer.amountBaseUnits),
          ],
        }),
      });

      setPhase('confirming');
      await put('/api/remittance', { orderId: prepared.orderId, txHash: hash });
      setPhase('sent');
    } catch (caught) {
      setPhase('form');
      setError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'sent') {
    return (
      <div className="mx-auto w-full max-w-lg">
        <Card>
          <CardContent className="space-y-4 py-8 text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-full border border-[var(--accent-border)] bg-[var(--accent-subtle)]">
              <Clock className="size-5 text-[var(--accent-text)]" />
            </span>
            <div>
              {/* "Being sent", never "sent". A person is still going to have to
                  pay this out by hand. */}
              <h2 className="text-lg font-semibold text-[var(--text)]">{t('receivedTitle')}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
                {t('receivedBody', {
                  amount: `${quote?.payoutAmount ?? ''} ${terms.currency}`,
                  name: beneficiaryName,
                })}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('sendTitle')}</CardTitle>
          <Badge tone="neutral">
            1 USD = {terms.fxRate} {terms.currency}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <Notice tone="negative">{error}</Notice> : null}

          <Field
            label={t('amount')}
            description={t('amountHint', { min: terms.minUsd, max: terms.maxUsd })}
          >
            {(props) => (
              <Input
                {...props}
                value={amountUsd}
                onChange={(event) => setAmountUsd(event.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                placeholder="50"
                className="num text-[20px]"
              />
            )}
          </Field>

          {quote ? (
            <div className="divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)] px-3">
              <DetailRow label={t('youSend')} value={`$${quote.amountUsd}`} />
              <DetailRow label={t('fee')} value={`$${quote.feeUsd}`} />
              <DetailRow
                label={t('theyReceive')}
                value={`${quote.payoutAmount} ${quote.payoutCurrency}`}
                emphasis
              />
            </div>
          ) : null}

          <Field label={t('recipientName')} description={t('recipientNameHint')}>
            {(props) => (
              <Input
                {...props}
                value={beneficiaryName}
                onChange={(event) => setBeneficiaryName(event.target.value)}
              />
            )}
          </Field>

          <Field label={t('recipientPhone')} description={t('recipientPhoneHint')}>
            {(props) => (
              <Input
                {...props}
                value={beneficiaryPhone}
                onChange={(event) => setBeneficiaryPhone(event.target.value)}
                inputMode="tel"
                placeholder="6xxxxxxx"
                className="num"
              />
            )}
          </Field>

          <Field label={t('relationship')} description={t('relationshipHint')}>
            {(props) => (
              <Input
                {...props}
                value={relationship}
                onChange={(event) => setRelationship(event.target.value)}
                placeholder={t('relationshipPlaceholder')}
              />
            )}
          </Field>

          <Field label={t('purpose')} description={t('purposeHint')}>
            {(props) => (
              <Input
                {...props}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder={t('purposePlaceholder')}
              />
            )}
          </Field>

          {wallets.length > 1 ? (
            <Field label={t('fromWallet')}>
              {(props) => (
                <select
                  {...props}
                  value={walletId}
                  onChange={(event) => setWalletId(event.target.value)}
                  className="w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-transparent px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
                >
                  {wallets.map((wallet) => (
                    <option key={wallet.id} value={wallet.id}>
                      {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}

          {!isConnected ? <Notice tone="info">{t('connectWallet')}</Notice> : null}

          <Button
            variant="primary"
            block
            size="lg"
            loading={busy}
            disabled={!complete || !isConnected}
            onClick={() => void send()}
          >
            <Send className="size-4" />
            {phase === 'signing'
              ? t('signInWallet')
              : phase === 'confirming'
                ? t('confirming')
                : t('sendCta')}
          </Button>

          {/* Stated before they part with anything, not after. */}
          <Notice tone="warning" title={t('manualTitle')}>
            {t('manualBody')}
          </Notice>
        </CardContent>
      </Card>

      {history.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('yourTransfers')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {history.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-[13px] text-[var(--text)]">
                    {row.beneficiaryName}
                    <ArrowRight className="mx-1 inline size-3 text-[var(--text-subtle)]" />
                    <span className="num">
                      {row.payoutAmount} {row.payoutCurrency}
                    </span>
                  </p>
                  <p className="truncate text-[11px] text-[var(--text-subtle)]">
                    {new Date(row.createdAt).toLocaleDateString()}
                    {row.payoutReference ? ` · ${row.payoutReference}` : ''}
                    {row.reviewNote ? ` · ${row.reviewNote}` : ''}
                  </p>
                </div>
                <StatusPill
                  tone={
                    row.status === 'PAID'
                      ? 'positive'
                      : row.status === 'REJECTED'
                        ? 'negative'
                        : 'warning'
                  }
                >
                  {row.status === 'PAID' ? (
                    <Check className="size-3" />
                  ) : row.status === 'REJECTED' ? (
                    <X className="size-3" />
                  ) : (
                    <Clock className="size-3" />
                  )}
                  {t(`status.${row.status}` as 'status.PAID')}
                </StatusPill>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
