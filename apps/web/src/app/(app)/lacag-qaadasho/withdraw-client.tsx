'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowDownToLine } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Notice,
  StatusPill,
} from '@flt/ui';
import { ApiError, idempotencyKey, post } from '@/lib/api';

interface AssetOption {
  asset: string;
  available: string;
}

interface HistoryRow {
  id: string;
  asset: string;
  amount: string;
  destinationAddress: string;
  txHash: string | null;
  status: string;
  failureReason: string | null;
  createdAt: string;
}

/**
 * Requesting a withdrawal.
 *
 * The form reserves the amount on the ledger; it does not move funds. The
 * screen is deliberate about that — a request is not a settlement, and the
 * balance shifts when the omnibus transfer confirms, not when the button is
 * pressed.
 */
export function WithdrawClient({
  assets,
  chainId,
  history,
}: {
  assets: AssetOption[];
  chainId: number;
  history: HistoryRow[];
}) {
  const t = useTranslations('withdrawPage');
  const router = useRouter();

  const [asset, setAsset] = useState(assets[0]?.asset ?? '');
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const selected = assets.find((option) => option.asset === asset);
  const overBalance =
    Boolean(amount) && selected ? Number(amount) > Number(selected.available) : false;
  const validAddress = /^0x[a-fA-F0-9]{40}$/.test(destination.trim());

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await post(
        '/api/withdrawals',
        {
          asset,
          chainId,
          amount: amount.trim(),
          destinationAddress: destination.trim(),
        },
        idempotencyKey(),
      );
      setSubmitted(true);
      setAmount('');
      setDestination('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  if (assets.length === 0) {
    return (
      <Card>
        <CardContent>
          <p className="py-6 text-center text-[13px] text-[var(--text-muted)]">{t('noAssets')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('formTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <Notice tone="negative">{error}</Notice> : null}
          {submitted ? <Notice tone="info">{t('submitted')}</Notice> : null}

          <Field label={t('asset')}>
            {(props) => (
              <select
                {...props}
                value={asset}
                onChange={(event) => setAsset(event.target.value)}
                className="w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-transparent px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
              >
                {assets.map((option) => (
                  <option key={option.asset} value={option.asset}>
                    {option.asset} — {option.available}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field
            label={t('amountLabel')}
            description={selected ? t('available', { amount: selected.available }) : undefined}
          >
            {(props) => (
              <Input
                {...props}
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                placeholder="0.0"
                className="num"
              />
            )}
          </Field>

          <Field label={t('destination')} description={t('destinationHint')}>
            {(props) => (
              <Input
                {...props}
                value={destination}
                onChange={(event) => setDestination(event.target.value.trim())}
                placeholder="0x…"
                className="num"
              />
            )}
          </Field>

          {overBalance ? <Notice tone="warning">{t('overBalance')}</Notice> : null}
          {destination && !validAddress ? <Notice tone="warning">{t('badAddress')}</Notice> : null}

          <Button
            variant="primary"
            block
            size="lg"
            loading={busy}
            disabled={!amount || overBalance || !validAddress}
            onClick={() => void submit()}
          >
            <ArrowDownToLine className="size-4" />
            {t('requestWithdrawal')}
          </Button>

          <p className="text-center text-[11px] leading-relaxed text-[var(--text-subtle)]">
            {t('timingNote')}
          </p>
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
                    {row.amount} {row.asset}
                  </p>
                  <p className="truncate font-mono text-[11px] text-[var(--text-subtle)]">
                    {row.destinationAddress}
                  </p>
                </div>
                <StatusPill
                  tone={
                    row.status === 'COMPLETED'
                      ? 'positive'
                      : row.status === 'FAILED'
                        ? 'negative'
                        : 'warning'
                  }
                >
                  {t(`status.${row.status}` as 'status.PENDING')}
                </StatusPill>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
