'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Notice } from '@flt/ui';
import { ApiError, del, get, post } from '@/lib/api';

/**
 * Writing, funding and ending a protection policy.
 *
 * ## The copy rule this component exists to keep
 *
 * A policy is a calculation and a declaration. It is not cover. So: no
 * "protected" badge, no "you're covered", and the funding control says
 * *declare* rather than *deposit*, because nothing is deposited anywhere —
 * FLT holds no participant funds and the participant's capital never leaves
 * wherever they keep it.
 *
 * The reduction control is the sharpest case. §7 describes automatic position
 * reduction; this button computes one and shows it. It cannot place the trade,
 * and the button label says "Show me the reduction" rather than "Reduce"
 * precisely so nobody presses it expecting their position to change.
 */

interface Policy {
  id: string;
  kind: 'BASE_DAY' | 'BASE_SMOOTH' | 'OMNI';
  state: string;
  side: string;
  entryPrice: string;
  referencePrice: string;
  notional: string;
  terms: {
    percentile: string;
    zConvention: string;
    horizonDays: string;
    volatilityInterval: string;
    volatilityWindow: number;
  };
  lastCalculation: {
    zScore: string | null;
    dailySigma: string | null;
    statisticalMove: string | null;
    boundary: string | null;
    requiredContribution: string | null;
    at: string | null;
  };
  declaredContribution: string;
  nextRebaseAt: string | null;
  symbol?: string;
}

interface Advice {
  reduction: string;
  reductionFraction: string;
  approximateSize: string;
  note: string;
}

const KIND_LABEL_KEYS: Record<string, string> = {
  BASE_DAY: 'kindBaseDay',
  BASE_SMOOTH: 'kindBaseSmooth',
  OMNI: 'kindOmni',
};

const KIND_BLURB_KEYS: Record<string, string> = {
  BASE_DAY: 'blurbBaseDay',
  BASE_SMOOTH: 'blurbBaseSmooth',
  OMNI: 'blurbOmni',
};

/** States where the participant needs to do something. */
const NEEDS_ATTENTION = ['WARNING', 'REBALANCE_REQUIRED', 'POSITION_REDUCTION'];

export function PolicyManager({
  symbol,
  hasPosition,
}: {
  symbol: string;
  /** Without one there is nothing to anchor a policy to, and the API refuses. */
  hasPosition: boolean;
}) {
  const t = useTranslations('policyManager');
  const locale = useLocale();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [declared, setDeclared] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await get<{ policies: Policy[] }>('/api/protection/policies');
      const open = data.policies.find(
        (candidate) =>
          candidate.symbol === symbol &&
          !['LIQUIDATED', 'EXPIRED', 'CANCELLED'].includes(candidate.state),
      );
      setPolicy(open ?? null);
      setDeclared(open?.declaredContribution ?? '');
      setError(null);
    } catch (caught) {
      // Signed out is the common case and is not an error worth showing.
      if (caught instanceof ApiError && caught.status === 401) setPolicy(null);
      else setError(readError(caught, t));
    } finally {
      setLoaded(true);
    }
  }, [symbol]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(readError(caught, t));
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) return <p className="text-[10.5px] text-[var(--text-subtle)]">{t('loading')}</p>;

  if (!policy) {
    return (
      <div className="space-y-2">
        {error ? <Notice tone="negative">{error}</Notice> : null}
        <p className="text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
          {hasPosition
            ? t('writePolicyWithPosition', { symbol })
            : t('writePolicyNoPosition', { symbol })}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(['BASE_DAY', 'BASE_SMOOTH', 'OMNI'] as const).map((kind) => (
            <Button
              key={kind}
              variant="secondary"
              disabled={!hasPosition}
              loading={busy === kind}
              onClick={() =>
                void run(kind, () =>
                  post('/api/protection/policies', { kind, symbol }),
                )
              }
              title={t(KIND_BLURB_KEYS[kind] ?? 'blurbOmni')}
            >
              {t(KIND_LABEL_KEYS[kind] ?? 'kindOmni')}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  const required = Number(policy.lastCalculation.requiredContribution ?? 0);
  const held = Number(policy.declaredContribution);
  const shortfall = Math.max(0, required - held);

  return (
    <div className="space-y-2.5">
      {error ? <Notice tone="negative">{error}</Notice> : null}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[var(--text)]">{t(KIND_LABEL_KEYS[policy.kind] ?? 'kindOmni')}</span>
        <span
          className={`font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] ${
            NEEDS_ATTENTION.includes(policy.state)
              ? 'text-[var(--warning)]'
              : 'text-[var(--text-subtle)]'
          }`}
        >
          {policy.state.replace(/_/g, ' ')}
        </span>
      </div>

      <Row label={t('reference')} value={usd(policy.referencePrice)} />
      <Row label={t('boundary')} value={usd(policy.lastCalculation.boundary)} />
      <Row label={t('wouldRequire')} value={usd(policy.lastCalculation.requiredContribution)} />
      <Row label={t('youDeclared')} value={usd(policy.declaredContribution)} />
      {shortfall > 0 ? (
        <Row label={t('shortfall')} value={usd(String(shortfall))} tone="warning" />
      ) : null}
      {policy.nextRebaseAt ? (
        <Row label={t('nextRebase')} value={new Date(policy.nextRebaseAt).toLocaleString(locale)} />
      ) : null}

      <div className="flex items-center gap-1.5 pt-1">
        <input
          value={declared}
          onChange={(event) => setDeclared(event.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          aria-label={t('capitalHeldAria')}
          className="w-24 rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-1.5 py-1 font-[family-name:var(--font-mono)] text-[11px] tabular-nums text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
        />
        <Button
          variant="secondary"
          loading={busy === 'fund'}
          disabled={!/^\d+(\.\d+)?$/.test(declared.trim())}
          onClick={() =>
            void run('fund', () =>
              post(`/api/protection/policies/${policy.id}/fund`, {
                declaredAmount: declared.trim(),
              }),
            )
          }
        >
          {t('declareHeld')}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {policy.kind === 'OMNI' ? (
          <Button
            variant="secondary"
            loading={busy === 'rebase'}
            onClick={() =>
              void run('rebase', () => post(`/api/protection/policies/${policy.id}/rebase`, {}))
            }
          >
            {t('rebaseNow')}
          </Button>
        ) : null}

        <Button
          variant="secondary"
          loading={busy === 'reduce'}
          onClick={() =>
            void run('reduce', async () => {
              setAdvice(
                await post<Advice>(`/api/protection/policies/${policy.id}/reduce`, {}),
              );
            })
          }
        >
          {t('showReduction')}
        </Button>

        <Button
          variant="ghost"
          loading={busy === 'cancel'}
          onClick={() => void run('cancel', () => del(`/api/protection/policies/${policy.id}`))}
        >
          {t('endPolicy')}
        </Button>
      </div>

      {advice ? (
        <Notice tone={Number(advice.reduction) > 0 ? 'warning' : 'positive'}>
          {Number(advice.reduction) > 0
            ? t('reductionAdvice', {
                amount: usd(advice.reduction),
                contracts: Number(advice.approximateSize).toFixed(4),
                pct: (Number(advice.reductionFraction) * 100).toFixed(1),
                note: advice.note,
              })
            : t('noReductionNeeded')}
        </Notice>
      ) : null}

      <p className="text-[10px] leading-relaxed text-[var(--text-subtle)]">
        {t('footerNote')}
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warning';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span
        className={`font-[family-name:var(--font-mono)] tabular-nums ${
          tone === 'warning' ? 'text-[var(--warning)]' : 'text-[var(--text)]'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function usd(value: string | null): string {
  if (value === null) return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  const decimals = Math.abs(amount) >= 100 ? 2 : 4;
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function readError(caught: unknown, t: ReturnType<typeof useTranslations<'policyManager'>>): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error) return caught.message;
  return t('genericError');
}
