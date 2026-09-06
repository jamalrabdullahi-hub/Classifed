'use client';

import { useCallback, useEffect, useState } from 'react';
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

const KIND_LABELS: Record<string, string> = {
  BASE_DAY: 'Base Day',
  BASE_SMOOTH: 'Base Smooth',
  OMNI: 'Omni',
};

const KIND_BLURBS: Record<string, string> = {
  BASE_DAY: 'Anchored to your entry price, one day, never rebased.',
  BASE_SMOOTH: 'Anchored to entry, but scales its recommendation as the position deteriorates.',
  OMNI: 'Re-anchors to the current price at each rebase, and recalculates volatility with it.',
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
      else setError(readError(caught));
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
      setError(readError(caught));
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) return <p className="text-[10.5px] text-[var(--text-subtle)]">Loading…</p>;

  if (!policy) {
    return (
      <div className="space-y-2">
        {error ? <Notice tone="negative">{error}</Notice> : null}
        <p className="text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
          {hasPosition ? (
            <>
              Write a policy to record this calculation against your open {symbol} position. It
              commits nothing, moves no money, and does not let FLT act on your position — it
              records what protection would require, and tracks it as prices move.
            </>
          ) : (
            <>
              A policy anchors to a real entry price and is measured against the venue&apos;s
              liquidation price, so one can only be written once you hold a {symbol} position.
              The figures above are a hypothetical.
            </>
          )}
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
              title={KIND_BLURBS[kind]}
            >
              {KIND_LABELS[kind]}
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
        <span className="text-[var(--text)]">{KIND_LABELS[policy.kind]}</span>
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

      <Row label="Reference" value={usd(policy.referencePrice)} />
      <Row label="Boundary" value={usd(policy.lastCalculation.boundary)} />
      <Row label="Would require" value={usd(policy.lastCalculation.requiredContribution)} />
      <Row label="You declared" value={usd(policy.declaredContribution)} />
      {shortfall > 0 ? (
        <Row label="Shortfall" value={usd(String(shortfall))} tone="warning" />
      ) : null}
      {policy.nextRebaseAt ? (
        <Row label="Next rebase" value={new Date(policy.nextRebaseAt).toLocaleString()} />
      ) : null}

      <div className="flex items-center gap-1.5 pt-1">
        <input
          value={declared}
          onChange={(event) => setDeclared(event.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          aria-label="Capital you hold against this policy"
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
          Declare held
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
            Rebase now
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
          Show me the reduction
        </Button>

        <Button
          variant="ghost"
          loading={busy === 'cancel'}
          onClick={() => void run('cancel', () => del(`/api/protection/policies/${policy.id}`))}
        >
          End policy
        </Button>
      </div>

      {advice ? (
        <Notice tone={Number(advice.reduction) > 0 ? 'warning' : 'positive'}>
          {Number(advice.reduction) > 0 ? (
            <>
              Close about {usd(advice.reduction)} of notional — roughly{' '}
              {Number(advice.approximateSize).toFixed(4)} contracts,{' '}
              {(Number(advice.reductionFraction) * 100).toFixed(1)}% of the position. {advice.note}
            </>
          ) : (
            <>
              No reduction needed. What you have declared covers the current requirement.
            </>
          )}
        </Notice>
      ) : null}

      <p className="text-[10px] leading-relaxed text-[var(--text-subtle)]">
        Declaring capital records a figure; it does not send anything to FLT, and FLT holds
        nothing on your behalf. Ending a policy stops the calculation — it does not close your
        position.
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

function readError(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error) return caught.message;
  return 'Something went wrong.';
}
