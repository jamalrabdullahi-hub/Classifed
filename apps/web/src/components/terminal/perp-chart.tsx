'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Candle, PerpCandleInterval } from '@flt/core/ports';
import { cn } from '@flt/ui';
import { ApiError, get } from '@/lib/api';
import { PriceChart, type PriceLineSpec } from '@/components/price-chart';
import {
  INDICATOR_TYPES,
  defaultParams,
  indicatorPolicyFor,
  type IndicatorSpec,
  type IndicatorType,
} from '@/lib/indicators';

/**
 * The terminal's chart panel.
 *
 * Reuses the same Lightweight Charts component the spot market pages draw with,
 * rather than a second implementation. It already reads the palette from the
 * DOM and re-reads it on a theme change, and duplicating that would guarantee
 * the two charts drift apart the first time a colour token is retuned.
 *
 * Candles are refetched on a timer rather than streamed. A websocket would be
 * tighter, but the last candle is only worth as much as the mark price beside
 * it, and that is polled too — a chart updating faster than the number the
 * position is marked against would imply a precision the screen does not have.
 */

const INTERVALS: PerpCandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

/** How often each interval is worth refetching. A daily candle is not urgent. */
const REFRESH_MS: Record<PerpCandleInterval, number> = {
  '1m': 5_000,
  '5m': 10_000,
  '15m': 20_000,
  '1h': 60_000,
  '4h': 120_000,
  '1d': 300_000,
};

export function PerpChart({
  symbol,
  height = 360,
  priceLines = [],
  historyNote,
  tier = 'FREE',
}: {
  symbol: string;
  height?: number;
  /** Protection boundary and liquidation price, drawn across the price axis. */
  priceLines?: PriceLineSpec[];
  /**
   * Attribution, when the candles did not come from the trading venue.
   *
   * Ostium fills against an oracle and publishes no history, so its charts are
   * drawn from the underlying's own market. The two track each other closely —
   * every mapping was checked — but the reader is entitled to know which is
   * which, especially where a metal is charted from the front-month future and
   * carries a basis over the spot the contract marks against.
   */
  historyNote?: string | null;
  /** Subscription tier, for the indicator allowance. */
  tier?: string;
}) {
  const t = useTranslations('perpChartPanel');
  const [interval, setInterval_] = useState<PerpCandleInterval>('15m');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [indicators, setIndicators] = useState<IndicatorSpec[]>([]);
  const policy = indicatorPolicyFor(tier);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const next = await get<{ candles: Candle[] }>(
          `/api/perps/markets/${encodeURIComponent(symbol)}/candles?interval=${interval}&limit=240`,
        );
        if (cancelled) return;
        setCandles(next.candles);
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : t('chartUnavailable'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS[interval]);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [symbol, interval]);

  function addIndicator(type: IndicatorType): void {
    if (!policy.allowed.includes(type)) return;
    if (indicators.length >= policy.max) return;
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${type}-${Date.now()}`;
    setIndicators((current) => [...current, { id, type, params: defaultParams(type) }]);
  }

  function removeIndicator(id: string): void {
    setIndicators((current) => current.filter((spec) => spec.id !== id));
  }

  function updateParam(id: string, key: string, value: number, min: number, max: number): void {
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(Math.max(Math.round(value), min), max);
    setIndicators((current) =>
      current.map((spec) =>
        spec.id === id ? { ...spec, params: { ...spec.params, [key]: clamped } } : spec,
      ),
    );
  }

  // Price precision follows magnitude: a $79,000 contract and a $0.14 one need
  // different axes, and a fixed two places makes one of them unreadable.
  const last = candles[candles.length - 1]?.close ?? 0;
  const precision = last >= 1000 ? 1 : last >= 1 ? 2 : last >= 0.01 ? 4 : 6;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-0.5 border-b border-[var(--border)] px-2 py-1">
        {INTERVALS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setInterval_(option)}
            aria-pressed={interval === option}
            className={cn(
              'rounded-[3px] px-2 py-1 font-[family-name:var(--font-mono)] text-[10.5px] transition-colors',
              interval === option
                ? 'bg-[var(--surface-raised)] text-[var(--text)]'
                : 'text-[var(--text-subtle)] hover:text-[var(--text-muted)]',
            )}
          >
            {option}
          </button>
        ))}
        <span className="mx-1 h-3.5 w-px bg-[var(--border)]" aria-hidden="true" />
        {policy.allowed.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => addIndicator(type)}
            disabled={indicators.length >= policy.max}
            aria-label={`Add ${INDICATOR_TYPES[type].label}`}
            className="rounded-[3px] px-2 py-1 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--text-subtle)] transition-colors hover:text-[var(--text-muted)] disabled:opacity-40"
          >
            +{INDICATOR_TYPES[type].label}
          </button>
        ))}
        <span className="ml-auto pr-1 font-[family-name:var(--font-mono)] text-[9.5px] text-[var(--text-subtle)]">
          {indicators.length}/{policy.max}
        </span>
      </div>

      {indicators.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-2 py-1">
          {indicators.map((spec) => (
            <div
              key={spec.id}
              className="flex items-center gap-1.5 rounded-[3px] bg-[var(--surface-raised)] px-1.5 py-0.5"
            >
              <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-muted)]">
                {INDICATOR_TYPES[spec.type].label}
              </span>
              {INDICATOR_TYPES[spec.type].params.map((param) => (
                <label key={param.key} className="flex items-center gap-1">
                  <span className="text-[9px] uppercase tracking-[0.06em] text-[var(--text-subtle)]">
                    {param.label}
                  </span>
                  <input
                    type="number"
                    value={spec.params[param.key] ?? param.default}
                    min={param.min}
                    max={param.max}
                    step={param.step ?? 1}
                    onChange={(event) =>
                      updateParam(spec.id, param.key, Number(event.target.value), param.min, param.max)
                    }
                    className="w-11 rounded-[2px] border border-[var(--border)] bg-transparent px-1 py-[1px] font-[family-name:var(--font-mono)] text-[10px] text-[var(--text)] outline-none"
                  />
                </label>
              ))}
              <button
                type="button"
                onClick={() => removeIndicator(spec.id)}
                aria-label={`Remove ${INDICATOR_TYPES[spec.type].label}`}
                className="px-0.5 text-[11px] text-[var(--text-subtle)] hover:text-[var(--text)]"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex-1">
        {!loading && !error && candles.length === 0 ? (
          <p className="p-6 text-center text-[12px] text-[var(--text-subtle)]">
            {t('noHistory')}
          </p>
        ) : error && candles.length === 0 ? (
          <p className="p-6 text-center text-[12px] text-[var(--text-subtle)]">{error}</p>
        ) : loading && candles.length === 0 ? (
          <p className="p-6 text-center text-[12px] text-[var(--text-subtle)]">{t('loadingChart')}</p>
        ) : (
          <PriceChart
            candles={candles}
            interval={interval}
            precision={precision}
            height={height}
            priceLines={priceLines}
            indicators={indicators}
          />
        )}
      </div>

      {historyNote && candles.length > 0 ? (
        <p className="border-t border-[var(--border)] px-2.5 py-1 text-[9.5px] text-[var(--text-subtle)]">
          {historyNote}
        </p>
      ) : null}
    </div>
  );
}
