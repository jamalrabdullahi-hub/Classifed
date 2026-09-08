'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAccount, useSendTransaction, useSwitchChain } from 'wagmi';
import { Check, Minus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Notice, cn } from '@flt/ui';
import { ApiError, post, put } from '@/lib/api';

/**
 * The plan ladder.
 *
 * ## The discount is shown as money
 *
 * "10% off trading fees" means nothing without knowing the fee. So each paid
 * plan states the break-even volume — the monthly turnover at which the fee
 * saving covers the subscription — because that is the only number that makes
 * the decision arithmetic instead of persuasion. It is computed from the live
 * fee rule, not from a figure typed into this file.
 *
 * ## No auto-renewal, said plainly
 *
 * Every subscription page the reader has ever seen renews silently, so the one
 * that does not has to say so. FLT holds no key that could charge them again;
 * that is worth stating as a feature rather than hiding as a limitation.
 */

interface Plan {
  tier: string;
  name: string;
  tagline: string;
  priceUsd: string;
  isFeatured: boolean;
  feeDiscountBps: number;
  maxLeverage: number;
  watchlistLimit: number | null;
  priceAlertLimit: number | null;
  historyDays: number | null;
  advancedOrderTools: boolean;
  fullIndicators: boolean;
  advancedRiskAnalytics: boolean;
  advancedProtectionAnalytics: boolean;
  fundingAnalytics: boolean;
  advancedPnl: boolean;
  fullPnl: boolean;
  apiAccess: boolean;
  priorityData: boolean;
  prioritySupport: boolean;
}

type Phase = 'idle' | 'preparing' | 'signing' | 'confirming' | 'done';

export function PlanPicker({
  plans,
  currentTier,
  expiresAt,
  currentSubscriptionId,
  baseFeeBps,
  guest = false,
}: {
  plans: Plan[];
  currentTier: string;
  expiresAt: string | null;
  currentSubscriptionId: string | null;
  baseFeeBps: number;
  /** No session at all — every "Choose" becomes a sign-in prompt instead of a wallet purchase. */
  guest?: boolean;
}) {
  const { isConnected, chainId } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const t = useTranslations('plans');
  const locale = useLocale();

  const [phase, setPhase] = useState<Phase>('idle');
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function choose(plan: Plan) {
    setError(null);
    setDone(null);
    setBusyTier(plan.tier);
    setPhase('preparing');

    try {
      const prepared = await post<{
        subscriptionId: string;
        transfer: { to: string; token: string; chainId: number; data: `0x${string}` };
        note: string;
      }>('/api/subscriptions', { tier: plan.tier });

      // The transfer is on the payment token's chain, which need not be the one
      // the wallet is currently on.
      if (chainId !== prepared.transfer.chainId) {
        // The configured chain list is typed as a literal union, but the
        // payment chain comes from the database — a deployment can move its
        // payment token without a rebuild, so the id cannot be a literal here.
        await switchChainAsync({ chainId: prepared.transfer.chainId as never });
      }

      setPhase('signing');
      const hash = await sendTransactionAsync({
        to: prepared.transfer.token as `0x${string}`,
        data: prepared.transfer.data,
      });

      setPhase('confirming');
      const result = await put<{ endsAt: string; note: string }>('/api/subscriptions', {
        subscriptionId: prepared.subscriptionId,
        txHash: hash,
      });

      setDone(
        t('activeUntil', {
          plan: plan.name,
          date: new Date(result.endsAt).toLocaleDateString(locale),
        }),
      );
      setPhase('done');
    } catch (caught) {
      setPhase('idle');
      setError(readError(caught, t));
    } finally {
      setBusyTier(null);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Notice tone="negative">{error}</Notice> : null}
      {done ? <Notice tone="positive">{done}</Notice> : null}

      {currentTier !== 'FREE' && expiresAt ? (
        <Notice tone="neutral">
          {t('onPlanUntil', {
            plan: plans.find((p) => p.tier === currentTier)?.name ?? currentTier,
            date: new Date(expiresAt).toLocaleDateString(locale),
          })}
        </Notice>
      ) : null}

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => {
          const isCurrent = plan.tier === currentTier;
          const isFree = plan.tier === 'FREE';

          return (
            <div
              key={plan.tier}
              className={cn(
                'flex flex-col rounded-[var(--radius-lg)] border p-3',
                plan.isFeatured
                  ? 'border-[var(--text)] bg-[var(--surface-raised)]'
                  : 'border-[var(--border)]',
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-[15px] font-semibold text-[var(--text)]">{plan.name}</h3>
                {plan.isFeatured ? (
                  <span className="rounded-[3px] bg-[var(--text)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.07em] text-[var(--canvas)]">
                    {t('mostPopular')}
                  </span>
                ) : null}
              </div>

              <p className="mt-0.5 text-[10.5px] leading-snug text-[var(--text-subtle)]">
                {plan.tagline}
              </p>

              <p className="mt-2 font-[family-name:var(--font-mono)] text-[22px] tabular-nums text-[var(--text)]">
                ${plan.priceUsd}
                <span className="ml-1 text-[11px] text-[var(--text-subtle)]">
                  {t('perThirtyDays')}
                </span>
              </p>

              {plan.feeDiscountBps > 0 ? (
                <div className="mt-1.5 rounded-[var(--radius)] border border-[var(--positive)] px-2 py-1">
                  <p className="text-[11px] font-medium text-[var(--positive)]">
                    {t('feeDiscount', { pct: plan.feeDiscountBps / 100 })}
                  </p>
                  <p className="mt-0.5 text-[9.5px] leading-relaxed text-[var(--text-subtle)]">
                    {t('breakEven', { amount: breakEven(plan, baseFeeBps) })}
                  </p>
                </div>
              ) : null}

              <ul className="mt-2.5 flex-1 space-y-1 text-[10.5px]">
                <Row on label={t('leverageUpTo', { n: plan.maxLeverage })} />
                <Row on label={t('watchlists', { n: limit(plan.watchlistLimit, t) })} />
                <Row on label={t('priceAlerts', { n: limit(plan.priceAlertLimit, t) })} />
                <Row on label={t('tradeHistory', { n: history(plan.historyDays, t) })} />
                <Row on={plan.advancedOrderTools} label={t('advancedOrderTools')} />
                <Row on={plan.fullIndicators} label={t('fullIndicators')} />
                <Row on={plan.advancedRiskAnalytics} label={t('advancedRiskAnalytics')} />
                <Row on={plan.advancedProtectionAnalytics} label={t('advancedProtectionAnalytics')} />
                <Row on={plan.fundingAnalytics} label={t('fundingAnalytics')} />
                <Row
                  on={plan.fullPnl || plan.advancedPnl}
                  label={plan.fullPnl ? t('fullPnl') : t('advancedPnl')}
                />
                <Row on={plan.apiAccess} label={t('apiAccess')} />
                <Row on={plan.priorityData} label={t('priorityData')} />
                <Row on={plan.prioritySupport} label={t('prioritySupport')} />
              </ul>

              <div className="mt-3">
                {isCurrent ? (
                  <p className="text-center text-[11px] text-[var(--text-subtle)]">
                    {t('currentPlanLabel')}
                  </p>
                ) : isFree ? (
                  <p className="text-center text-[11px] text-[var(--text-subtle)]">
                    {t('freeIncluded')}
                  </p>
                ) : guest ? (
                  <Button asChild variant={plan.isFeatured ? 'primary' : 'secondary'} block>
                    <Link href="/gal">{t('signInToChoose')}</Link>
                  </Button>
                ) : (
                  <Button
                    variant={plan.isFeatured ? 'primary' : 'secondary'}
                    block
                    disabled={!isConnected || busyTier !== null}
                    loading={busyTier === plan.tier}
                    onClick={() => void choose(plan)}
                  >
                    {phaseLabel(busyTier === plan.tier ? phase : 'idle', plan.name, t)}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!guest && !isConnected ? (
        <Notice tone="warning" title={t('connectWalletTitle')}>
          {t('connectWalletBody')}
        </Notice>
      ) : null}

      <p className="text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
        {t('footerNote')}{' '}
        {currentSubscriptionId ? t('cancelNote') : ''}
      </p>
    </div>
  );
}

function Row({ on, label }: { on: boolean; label: string }) {
  return (
    <li className="flex items-center gap-1.5 leading-tight">
      {on ? (
        <Check className="size-3 shrink-0 text-[var(--positive)]" />
      ) : (
        <Minus className="size-3 shrink-0 text-[var(--text-subtle)]" />
      )}
      <span className={on ? 'text-[var(--text-muted)]' : 'text-[var(--text-subtle)] opacity-60'}>
        {label}
      </span>
    </li>
  );
}

function limit(value: number | null, t: ReturnType<typeof useTranslations>): string {
  return value === null ? t('unlimited') : String(value);
}

function history(days: number | null, t: ReturnType<typeof useTranslations>): string {
  if (days === null) return t('unlimited');
  if (days >= 365) return t('year', { n: Math.round(days / 365) });
  return t('days', { n: days });
}

/**
 * The monthly volume at which the fee saving covers the subscription.
 *
 *   saving per dollar traded = baseFee × discount
 *   break-even volume        = price / saving
 *
 * Stated as a round figure, because the point is the order of magnitude — "about
 * thirty thousand a month" is the decision, not $31,987.
 */
function breakEven(plan: Plan, baseFeeBps: number): string {
  const savedBps = (baseFeeBps * plan.feeDiscountBps) / 10_000;
  if (savedBps <= 0) return '—';

  const volume = (Number(plan.priceUsd) * 10_000) / savedBps;
  if (!Number.isFinite(volume)) return '—';

  if (volume >= 1_000_000) return `$${(volume / 1_000_000).toFixed(1)}M`;
  if (volume >= 1_000) return `$${Math.round(volume / 1_000)}k`;
  return `$${Math.round(volume)}`;
}

function phaseLabel(phase: Phase, name: string, t: ReturnType<typeof useTranslations>): string {
  if (phase === 'preparing') return t('preparing');
  if (phase === 'signing') return t('confirmInWallet');
  if (phase === 'confirming') return t('verifyingPayment');
  return t('chooseX', { name });
}

function readError(caught: unknown, t: ReturnType<typeof useTranslations>): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error) {
    if (/user rejected|denied|rejected the request/i.test(caught.message)) {
      return t('declined');
    }
    return caught.message;
  }
  return t('genericError');
}
