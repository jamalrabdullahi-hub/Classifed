'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Notice, cn } from '@flt/ui';

/**
 * The pitch, as arithmetic the reader can check.
 *
 * ## It is allowed to say no
 *
 * If the volume does not cover a plan, this says so rather than pushing anyway.
 * Not modesty — a trader who upgrades on a promise the numbers do not support
 * cancels next month and does not come back, and the interface that oversold
 * them is the same one that has to warn them about liquidation. Credibility
 * here is load-bearing elsewhere.
 *
 * ## The volume is theirs, the rest is computed
 *
 * FLT does not store the USD price at the moment of a fill, so a dollar volume
 * cannot be recovered from history without inventing it. The reader states
 * their own and everything else follows from the live fee rate.
 */

interface Plan {
  tier: string;
  name: string;
  tagline: string;
  priceUsd: string;
  isFeatured: boolean;
  feeDiscountBps: number;
  maxLeverage: number;
  apiAccess: boolean;
  advancedRiskAnalytics: boolean;
}

export function UpgradePitch({
  plans,
  currentTier,
  currentMaxLeverage,
  tradeCount,
  baseFeeBps,
}: {
  plans: Plan[];
  currentTier: string;
  currentMaxLeverage: number;
  tradeCount: number;
  baseFeeBps: number;
}) {
  const t = useTranslations('upgrade');
  const [volumeText, setVolumeText] = useState('10000');

  const monthlyVolume = Number(volumeText.replace(/[^\d.]/g, '')) || 0;
  const monthlyFees = (monthlyVolume * baseFeeBps) / 10_000;

  /** What each discounting plan nets per month, at the volume they typed. */
  const outcomes = useMemo(() => {
    return plans
      .filter((plan) => plan.tier !== 'FREE' && plan.feeDiscountBps > 0)
      .map((plan) => {
        const saved = (monthlyFees * plan.feeDiscountBps) / 10_000;
        const price = Number(plan.priceUsd);
        return { plan, saved, price, net: saved - price };
      })
      .sort((a, b) => b.net - a.net);
  }, [plans, monthlyFees]);

  const best = outcomes[0];
  const worthIt = best !== undefined && best.net > 0;

  if (currentTier !== 'FREE') {
    return (
      <Notice tone="positive" title={t('onPaidPlanTitle')}>
        {t('onPaidPlanBody')}{' '}
        <Link href="/plans" className="underline">
          {t('comparePlans')}
        </Link>{' '}
        {t('toMoveUpOrDown')}
      </Notice>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
        <h2 className="text-[13px] font-semibold text-[var(--text)]">{t('payForItselfTitle')}</h2>

        <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-subtle)]">
          {tradeCount > 0
            ? t(tradeCount === 1 ? 'tradeCountPrefix' : 'tradeCountPrefixPlural', {
                count: tradeCount,
              })
            : ''}
          {t('enterVolume', { bps: baseFeeBps })}
        </p>

        <label className="mt-3 block space-y-1">
          <span className="text-[10px] uppercase tracking-[0.07em] text-[var(--text-subtle)]">
            {t('monthlyVolumeLabel')}
          </span>
          <input
            value={volumeText}
            onChange={(event) => setVolumeText(event.target.value)}
            inputMode="decimal"
            aria-label={t('monthlyVolumeAria')}
            className="w-full max-w-xs rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] tabular-nums text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
          />
        </label>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Stat label={t('feesPerMonth')} value={money(monthlyFees)} />
          <Stat label={t('tradesIn90Days')} value={String(tradeCount)} />
        </div>

        <div className="mt-4 space-y-2 border-t border-[var(--border)] pt-3">
          {outcomes.map(({ plan, saved, price, net }) => (
            <div key={plan.tier} className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="text-[var(--text-muted)]">
                {plan.name}
                <span className="ml-1.5 text-[10px] text-[var(--text-subtle)]">
                  {t('savesAndCosts', { saved: money(saved), price: money(price) })}
                </span>
              </span>
              <span
                className={cn(
                  'shrink-0 font-[family-name:var(--font-mono)] tabular-nums',
                  net > 0 ? 'text-[var(--positive)]' : 'text-[var(--text-subtle)]',
                )}
              >
                {net > 0 ? '+' : ''}
                {money(net)} {t('perMonthShort')}
              </span>
            </div>
          ))}
        </div>

        {worthIt ? (
          <Notice tone="positive" className="mt-3">
            {t('worthItNotice', {
              volume: money(monthlyVolume),
              plan: best.plan.name,
              net: money(best.net),
            })}
          </Notice>
        ) : (
          <Notice tone="neutral" className="mt-3">
            {t('notWorthItNotice', { volume: money(monthlyVolume) })}
          </Notice>
        )}
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
        <h2 className="text-[13px] font-semibold text-[var(--text)]">
          {t('cappedTitle', { n: currentMaxLeverage })}
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
          {t('cappedBody', { n: currentMaxLeverage })}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {plans
          .filter((plan) => plan.tier !== 'FREE')
          .map((plan) => (
            <Link
              key={plan.tier}
              href="/plans"
              className={cn(
                'flex flex-col rounded-[var(--radius-lg)] border p-3 transition-colors',
                plan.isFeatured
                  ? 'border-[var(--text)] bg-[var(--surface-raised)]'
                  : 'border-[var(--border)] hover:border-[var(--text-muted)]',
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold text-[var(--text)]">{plan.name}</span>
                <span className="font-[family-name:var(--font-mono)] text-[13px] tabular-nums text-[var(--text)]">
                  ${plan.priceUsd}
                </span>
              </div>

              <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
                {plan.tagline}
              </p>

              <ul className="mt-2 flex-1 space-y-1 text-[10.5px] text-[var(--text-muted)]">
                <li className="flex items-center gap-1.5">
                  <Check className="size-3 shrink-0 text-[var(--positive)]" />
                  {t('upToX', { n: plan.maxLeverage })}
                </li>
                {plan.feeDiscountBps > 0 ? (
                  <li className="flex items-center gap-1.5">
                    <Check className="size-3 shrink-0 text-[var(--positive)]" />
                    {t('offFees', {
                      pct: plan.feeDiscountBps / 100,
                      bps: withDiscount(baseFeeBps, plan.feeDiscountBps),
                    })}
                  </li>
                ) : null}
                {plan.advancedRiskAnalytics ? (
                  <li className="flex items-center gap-1.5">
                    <Check className="size-3 shrink-0 text-[var(--positive)]" />
                    {t('advancedRiskAnalytics')}
                  </li>
                ) : null}
                {plan.apiAccess ? (
                  <li className="flex items-center gap-1.5">
                    <Check className="size-3 shrink-0 text-[var(--positive)]" />
                    {t('apiAccess')}
                  </li>
                ) : null}
              </ul>

              <span className="mt-2 flex items-center gap-1 text-[10.5px] text-[var(--text)]">
                {t('chooseArrow')} <ArrowRight className="size-3" />
              </span>
            </Link>
          ))}
      </div>

      <p className="text-[10.5px] leading-relaxed text-[var(--text-subtle)]">{t('footerNote')}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.07em] text-[var(--text-subtle)]">{label}</p>
      <p className="font-[family-name:var(--font-mono)] text-[16px] tabular-nums text-[var(--text)]">
        {value}
      </p>
    </div>
  );
}

function money(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `$${Math.round(value / 1_000)}k`;
  return `$${value.toFixed(2)}`;
}

function withDiscount(baseBps: number, discountBps: number): number {
  return Math.floor((baseBps * (10_000 - discountBps)) / 10_000);
}
