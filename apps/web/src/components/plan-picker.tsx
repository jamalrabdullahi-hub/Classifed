'use client';

import { useState } from 'react';
import { useAccount, useSendTransaction, useSwitchChain } from 'wagmi';
import { Check, Minus } from 'lucide-react';
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
}: {
  plans: Plan[];
  currentTier: string;
  expiresAt: string | null;
  currentSubscriptionId: string | null;
  baseFeeBps: number;
}) {
  const { isConnected, chainId } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();

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
        `${plan.name} is active until ${new Date(result.endsAt).toLocaleDateString()}. ` +
          'Nothing will renew automatically.',
      );
      setPhase('done');
    } catch (caught) {
      setPhase('idle');
      setError(readError(caught));
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
          You are on {plans.find((p) => p.tier === currentTier)?.name ?? currentTier} until{' '}
          {new Date(expiresAt).toLocaleDateString()}. Buying another plan adds the days you have
          left to the new period.
        </Notice>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => {
          const isCurrent = plan.tier === currentTier;
          const isFree = plan.tier === 'FREE';

          return (
            <div
              key={plan.tier}
              className={cn(
                'flex flex-col rounded-[var(--radius-lg)] border p-4',
                plan.isFeatured
                  ? 'border-[var(--text)] bg-[var(--surface-raised)]'
                  : 'border-[var(--border)]',
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-[15px] font-semibold text-[var(--text)]">{plan.name}</h3>
                {plan.isFeatured ? (
                  <span className="rounded-[3px] bg-[var(--text)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.07em] text-[var(--canvas)]">
                    Most popular
                  </span>
                ) : null}
              </div>

              <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-subtle)]">
                {plan.tagline}
              </p>

              <p className="mt-3 font-[family-name:var(--font-mono)] text-[24px] tabular-nums text-[var(--text)]">
                ${plan.priceUsd}
                <span className="ml-1 text-[11px] text-[var(--text-subtle)]">/ 30 days</span>
              </p>

              {plan.feeDiscountBps > 0 ? (
                <div className="mt-2 rounded-[var(--radius)] border border-[var(--positive)] px-2 py-1.5">
                  <p className="text-[11px] font-medium text-[var(--positive)]">
                    {plan.feeDiscountBps / 100}% off trading fees
                  </p>
                  <p className="mt-0.5 text-[9.5px] leading-relaxed text-[var(--text-subtle)]">
                    Pays for itself at {breakEven(plan, baseFeeBps)} of monthly volume.
                  </p>
                </div>
              ) : null}

              <ul className="mt-3 flex-1 space-y-1.5 text-[11px]">
                <Row on label={`Up to ${plan.maxLeverage}x leverage`} />
                <Row on label={`${limit(plan.watchlistLimit)} watchlists`} />
                <Row on label={`${limit(plan.priceAlertLimit)} price alerts`} />
                <Row on label={`${history(plan.historyDays)} trade history`} />
                <Row on={plan.advancedOrderTools} label="Advanced order tools" />
                <Row on={plan.fullIndicators} label="Full indicator set" />
                <Row on={plan.advancedRiskAnalytics} label="Advanced risk analytics" />
                <Row on={plan.advancedProtectionAnalytics} label="Advanced protection analytics" />
                <Row on={plan.fundingAnalytics} label="Funding-rate analytics" />
                <Row on={plan.fullPnl || plan.advancedPnl} label={plan.fullPnl ? 'Full P&L analytics' : 'Advanced P&L analytics'} />
                <Row on={plan.apiAccess} label="API access" />
                <Row on={plan.priorityData} label="Priority execution and data" />
                <Row on={plan.prioritySupport} label="Priority support" />
              </ul>

              <div className="mt-4">
                {isCurrent ? (
                  <p className="text-center text-[11px] text-[var(--text-subtle)]">
                    Your current plan
                  </p>
                ) : isFree ? (
                  <p className="text-center text-[11px] text-[var(--text-subtle)]">
                    What every account has
                  </p>
                ) : (
                  <Button
                    variant={plan.isFeatured ? 'primary' : 'secondary'}
                    block
                    disabled={!isConnected || busyTier !== null}
                    loading={busyTier === plan.tier}
                    onClick={() => void choose(plan)}
                  >
                    {phaseLabel(busyTier === plan.tier ? phase : 'idle', plan.name)}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!isConnected ? (
        <Notice tone="warning" title="Connect your wallet">
          A plan is paid by a transfer you sign yourself.
        </Notice>
      ) : null}

      <p className="text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
        Plans are paid one period at a time and do not renew automatically — FLT holds no key that
        could charge you again, which is the same reason it cannot move your trading funds. When a
        period ends the account returns to Free; positions, history and protection policies are
        untouched.{' '}
        {currentSubscriptionId ? 'Cancelling stops the plan but does not refund the current period.' : ''}
      </p>
    </div>
  );
}

function Row({ on, label }: { on: boolean; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      {on ? (
        <Check className="size-3 shrink-0 text-[var(--positive)]" />
      ) : (
        <Minus className="size-3 shrink-0 text-[var(--text-subtle)]" />
      )}
      <span className={on ? 'text-[var(--text-muted)]' : 'text-[var(--text-subtle)] line-through'}>
        {label}
      </span>
    </li>
  );
}

function limit(value: number | null): string {
  return value === null ? 'Unlimited' : String(value);
}

function history(days: number | null): string {
  if (days === null) return 'Unlimited';
  if (days >= 365) return `${Math.round(days / 365)} year`;
  return `${days} days`;
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

function phaseLabel(phase: Phase, name: string): string {
  if (phase === 'preparing') return 'Preparing…';
  if (phase === 'signing') return 'Confirm in your wallet';
  if (phase === 'confirming') return 'Verifying payment…';
  return `Choose ${name}`;
}

function readError(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error) {
    if (/user rejected|denied|rejected the request/i.test(caught.message)) {
      return 'You declined the transfer, so nothing was charged.';
    }
    return caught.message;
  }
  return 'Something went wrong and no plan was started.';
}
