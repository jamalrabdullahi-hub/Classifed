'use client';

import { useEffect, useMemo, useState } from 'react';
import { ApiError, get } from '@/lib/api';
import { PolicyManager } from './policy-manager';

/**
 * The protection readout (§16).
 *
 * ## Copy discipline: nothing here is protected
 *
 * No pool exists, no contribution is collected, and no claim could be paid. So
 * this panel says what protection *would* cost and where the boundary *would*
 * sit. It never says "you are covered", never shows a "current contribution"
 * balance that is really zero dressed up as a figure, and never implies FLT
 * will act on the position — it cannot, because the only key that can close a
 * position lives in the browser.
 *
 * ## Why all three policies at once
 *
 * The interesting fact about this design is how the three differ, and they only
 * differ in where the boundary is anchored. Showing one policy at a time hides
 * exactly that: a position up 20% has Base Day still measuring from entry while
 * Omni has already rebased to the current price. Three rows make it visible.
 *
 * ## The boundary against liquidation
 *
 * Shown always, because a boundary the venue would never let you reach is the
 * one failure mode a user cannot see for themselves. At 10x on BTC today the
 * Omni boundary already sits below Hyperliquid's liquidation price; the panel
 * has to say so rather than print a reassuring number.
 */

interface PolicyRow {
  policy: 'BASE_DAY' | 'BASE_SMOOTH' | 'OMNI';
  referencePrice: string;
  percentile: string;
  zScore: string;
  zConvention: string;
  horizonDays: string;
  dailySigma: string;
  statisticalMove: string;
  protectionBoundary: string;
  notional: string;
  statisticalRisk: string;
  baseContribution: string;
  modifiers: { iv: string; liquidity: string; gap: string; tail: string; combined: string };
  requiredContribution: string;
  standing: 'ahead-of-liquidation' | 'beyond-liquidation' | 'unknown';
  warnings: Array<{ code: string; message: string }>;
  smooth: {
    excursion: string;
    startAt: string;
    liquidationAt: string;
    utilization: string;
    targetNotional: string;
    recommendedReduction: string;
  } | null;
  settlement: {
    kind: 'release' | 'additional' | 'unchanged';
    previousContribution: string;
    requiredContribution: string;
    amount: string;
  } | null;
}

interface Calculation {
  symbol: string;
  currentPrice: string;
  position: {
    side: 'LONG' | 'SHORT';
    entryPrice: string;
    notional: string;
    liquidationPrice: string | null;
  };
  volatility: {
    model: string;
    interval: string;
    window: number;
    observations: number;
    dailySigma: string;
  };
  policies: Record<string, PolicyRow>;
}

interface LivePosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: string;
  liquidationPrice: string | null;
  notionalValue: string | null;
}

/**
 * The cover levels offered, matching the order ticket's presets exactly.
 *
 * These are the familiar σ-band figures. Read one-tailed — as a downside
 * boundary must be — 68% is z = 0.47, 95% is z = 1.64 and 99.7% is z = 2.75,
 * which is why the panel prints the z it used rather than leaving the reader
 * to assume the two-tailed 1σ/2σ/3σ values.
 *
 * Two more are kept beyond the presets because the calculator is where someone
 * explores the shape of the curve, not just the three points they can buy.
 */
const PERCENTILES = [
  { value: 0.68, label: '68%' },
  { value: 0.95, label: '95%' },
  { value: 0.997, label: '99.7%' },
  { value: 0.9999, label: '99.99%' },
];

const POLICY_LABELS: Record<string, string> = {
  BASE_DAY: 'Base Day',
  BASE_SMOOTH: 'Base Smooth',
  OMNI: 'Omni',
};

export function ProtectionPanel({
  symbol,
  markPrice,
}: {
  symbol: string;
  markPrice: string | null;
}) {
  const [percentile, setPercentile] = useState(0.95);
  const [horizonDays, setHorizonDays] = useState(10);
  const [position, setPosition] = useState<LivePosition | null>(null);
  const [calculation, setCalculation] = useState<Calculation | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The user's own position, when they have one on this market. Failure here is
  // not an error the panel should shout about — a signed-out visitor gets a
  // hypothetical, which is still a useful thing to look at.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const data = await get<{ positions: LivePosition[] }>('/api/perps/positions');
        if (cancelled) return;
        setPosition(data.positions.find((p) => p.symbol === symbol) ?? null);
      } catch {
        if (!cancelled) setPosition(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      percentile: String(percentile),
      horizonDays: String(horizonDays),
    });

    if (position) {
      params.set('side', position.side);
      params.set('entryPrice', position.entryPrice);
      if (position.notionalValue) params.set('notional', position.notionalValue);
      if (position.liquidationPrice) params.set('liquidationPrice', position.liquidationPrice);
    } else {
      // A hypothetical $1,000 long, labelled as such below. Entry is left out
      // deliberately: the endpoint then anchors it to the same live mark Omni
      // uses, so all three policies quote one reference price. Passing the
      // mark the ticker last rendered made the Base rows disagree with Omni by
      // a few dollars, which reads as an arithmetic fault rather than as two
      // prices read seconds apart.
      params.set('side', 'LONG');
      params.set('notional', '1000');
    }

    return params.toString();
  }, [percentile, horizonDays, position, markPrice]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await get<Calculation>(
          `/api/perps/markets/${symbol}/protection?${query}`,
        );
        if (!cancelled) {
          setCalculation(next);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : 'Calculation unavailable');
        }
      }
    }

    void load();
    // Slow: σ over a week of hourly candles does not move meaningfully in a
    // minute, and the venue's candle endpoint is the expensive one.
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbol, query]);

  if (error && !calculation) {
    return <Message>{error}</Message>;
  }
  if (!calculation) {
    return <Message>Calculating…</Message>;
  }

  const rows = ['BASE_DAY', 'BASE_SMOOTH', 'OMNI']
    .map((kind) => calculation.policies[kind])
    .filter((row): row is PolicyRow => Boolean(row));

  const omni = calculation.policies.OMNI;
  const smooth = calculation.policies.BASE_SMOOTH?.smooth ?? null;

  return (
    <div className="space-y-2.5 p-2.5 text-[11px] leading-relaxed">
      <p className="text-[10.5px] text-[var(--text-subtle)]">
        {position
          ? `Your ${position.side.toLowerCase()} on ${symbol}, ${fmtUsd(calculation.position.notional)} notional.`
          : `No position — priced as a hypothetical $1,000 long at ${fmtUsd(calculation.currentPrice)}.`}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Field label="Percentile">
          <select
            value={percentile}
            onChange={(event) => setPercentile(Number(event.target.value))}
            className="bg-transparent font-[family-name:var(--font-mono)] text-[var(--text)] outline-none"
          >
            {PERCENTILES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Omni rebase">
          <select
            value={horizonDays}
            onChange={(event) => setHorizonDays(Number(event.target.value))}
            className="bg-transparent font-[family-name:var(--font-mono)] text-[var(--text)] outline-none"
          >
            {[1, 3, 7, 10, 30].map((days) => (
              <option key={days} value={days}>
                {days}d
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Line
        label="Volatility"
        value={`${(Number(calculation.volatility.dailySigma) * 100).toFixed(2)}% / day`}
        hint={`${calculation.volatility.observations} × ${calculation.volatility.interval}`}
      />

      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-[family-name:var(--font-mono)] text-[10.5px] tabular-nums">
          <thead>
            <tr className="text-[9.5px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
              <th className="py-1 text-left font-normal">Policy</th>
              <th className="py-1 text-right font-normal">Ref</th>
              <th className="py-1 text-right font-normal">Move</th>
              <th className="py-1 text-right font-normal">Boundary</th>
              <th className="py-1 text-right font-normal">Would cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.policy} className="border-t border-[var(--border)]">
                <td className="py-1 pr-2 text-left font-[family-name:var(--font-sans)] text-[var(--text-muted)]">
                  {POLICY_LABELS[row.policy]}
                </td>
                <td className="py-1 text-right text-[var(--text-subtle)]">
                  {fmtUsd(row.referencePrice)}
                </td>
                <td className="py-1 text-right text-[var(--text-subtle)]">
                  {(Number(row.statisticalMove) * 100).toFixed(2)}%
                </td>
                <td
                  className={`py-1 text-right ${
                    row.standing === 'beyond-liquidation'
                      ? 'text-[var(--warning)]'
                      : 'text-[var(--text)]'
                  }`}
                >
                  {fmtUsd(row.protectionBoundary)}
                </td>
                <td className="py-1 text-right text-[var(--text)]">
                  {fmtUsd(row.requiredContribution)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {calculation.position.liquidationPrice ? (
        <Line
          label="Venue liquidation"
          value={fmtUsd(calculation.position.liquidationPrice)}
          hint="the venue's own number"
        />
      ) : null}

      {smooth ? (
        <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
          <Line
            label="Base Smooth utilisation"
            value={`${(Number(smooth.utilization) * 100).toFixed(1)}%`}
            hint={`starts at ${(Number(smooth.startAt) * 100).toFixed(1)}% adverse`}
          />
          {Number(smooth.recommendedReduction) > 0 ? (
            <p className="text-[10.5px] text-[var(--warning)]">
              Base Smooth would have you reduce {fmtUsd(smooth.recommendedReduction)} of notional,
              down to {fmtUsd(smooth.targetNotional)}. You would place that trade yourself.
            </p>
          ) : null}
        </div>
      ) : null}

      {omni && Number(omni.modifiers.combined) !== 1 ? (
        <Line label="Risk modifiers" value={`×${Number(omni.modifiers.combined).toFixed(3)}`} />
      ) : null}

      {rows.some((row) => row.standing === 'beyond-liquidation') ? (
        <p className="border-t border-[var(--border)] pt-2 text-[10.5px] text-[var(--warning)]">
          Boundaries shown in amber sit past where {calculation.position.liquidationPrice ? 'the venue' : 'your venue'} would
          liquidate this position — the position is closed before the boundary is reached, so that
          boundary describes an event that cannot happen. Lower the leverage, shorten the horizon,
          or drop the percentile.
        </p>
      ) : null}

      {/*
        The manager sits under the readout rather than beside it: a participant
        should see what the numbers are before being offered a control that
        records a commitment against them.
      */}
      <div className="border-t border-[var(--border)] pt-2.5">
        <PolicyManager symbol={symbol} hasPosition={position !== null} />
      </div>

      <p className="border-t border-[var(--border)] pt-2 text-[10.5px] text-[var(--text-subtle)]">
        This is a calculation, not cover. Nothing is collected and no claim can be paid. FLT cannot
        open, close or reduce your position — only the key in your browser can. z is one-tailed:{' '}
        {omni ? Number(omni.zScore).toFixed(4) : '—'} at {omni ? pct(omni.percentile) : '—'}.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function Line({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="text-right">
        <span className="font-[family-name:var(--font-mono)] tabular-nums text-[var(--text)]">
          {value}
        </span>
        {hint ? (
          <span className="ml-1.5 text-[10px] text-[var(--text-subtle)]">{hint}</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Two decimals for anything a dollar or more, more only below that.
 *
 * The earlier rule gave four decimals under $100, which put "$53.8862" beside
 * "$180.54" in the same column — the reader has to re-parse each row to compare
 * them. Sub-dollar prices still need the extra digits, because a token quoted
 * at $0.000023 renders as $0.00 otherwise.
 */
function fmtUsd(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  const decimals = Math.abs(amount) >= 1 ? 2 : 6;
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function pct(value: string): string {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <p className="p-2.5 text-[11px] text-[var(--text-subtle)]">{children}</p>
  );
}
