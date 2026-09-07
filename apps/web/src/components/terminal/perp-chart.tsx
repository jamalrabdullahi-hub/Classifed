'use client';

import { useEffect, useState } from 'react';
import type { Candle, PerpCandleInterval } from '@flt/core/ports';
import { cn } from '@flt/ui';
import { ApiError, get } from '@/lib/api';
import { PriceChart, type PriceLineSpec } from '@/components/price-chart';

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
}) {
  const [interval, setInterval_] = useState<PerpCandleInterval>('15m');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const next = await get<{ candles: Candle[] }>(
          `/api/perps/markets/${symbol}/candles?interval=${interval}&limit=240`,
        );
        if (cancelled) return;
        setCandles(next.candles);
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : 'Chart unavailable');
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
      </div>

      <div className="flex-1">
        {!loading && !error && candles.length === 0 ? (
          <p className="p-6 text-center text-[12px] text-[var(--text-subtle)]">
            No price history is available for this market.
          </p>
        ) : error && candles.length === 0 ? (
          <p className="p-6 text-center text-[12px] text-[var(--text-subtle)]">{error}</p>
        ) : loading && candles.length === 0 ? (
          <p className="p-6 text-center text-[12px] text-[var(--text-subtle)]">Loading chart…</p>
        ) : (
          <PriceChart
            candles={candles}
            interval={interval}
            precision={precision}
            height={height}
            priceLines={priceLines}
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
