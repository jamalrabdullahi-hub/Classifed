'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, LineChart } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, EmptyState, Skeleton, Tabs, TabsList, TabsTrigger, cn } from '@flt/ui';
import { CANDLE_INTERVALS, type Candle, type CandleInterval } from '@flt/core/ports';
import { PriceChart } from './price-chart';

/**
 * The chart, its interval control, and its provenance line.
 *
 * Fetching lives here rather than in the chart so the chart stays a pure
 * renderer. This component owns the states that are easy to forget: no pool
 * indexed, upstream unreachable, and data served from cache after a failure.
 *
 * Candles are shown with their source and their age. A price chart with no
 * attribution invites the reader to assume FLT is the one asserting the price,
 * and we are not — we are passing on a third party's view of a pool.
 */

interface Response {
  available: boolean;
  interval?: CandleInterval;
  candles?: Candle[];
  pool?: { address: string; dex: string; quoteSymbol: string | null };
  source?: string;
  fetchedAt?: string;
  stale?: boolean;
}

const LABELS: Record<CandleInterval, string> = {
  '5m': '5m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
};

/** How often to refetch, per interval. Long intervals barely move. */
const REFRESH_MS: Record<CandleInterval, number> = {
  '5m': 60_000,
  '1h': 300_000,
  '4h': 600_000,
  '1d': 900_000,
};

export function MarketChart({ address, symbol }: { address: string; symbol: string }) {
  const t = useTranslations('marketChart');
  const locale = useLocale();
  const [interval, setInterval] = useState<CandleInterval>('1h');
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Guards against a slow response for an interval the user has since left
  // overwriting the one they are now looking at.
  const requestSeq = useRef(0);

  const load = useCallback(
    async (next: CandleInterval, showSpinner: boolean) => {
      const seq = ++requestSeq.current;
      if (showSpinner) setLoading(true);

      try {
        const response = await fetch(
          `/api/markets/${address}/candles?interval=${next}`,
          { headers: { accept: 'application/json' } },
        );
        const payload = await response.json();

        if (seq !== requestSeq.current) return;

        if (!response.ok) {
          setError(payload?.error?.message ?? t('couldNotLoad'));
        } else {
          setData(payload.data as Response);
          setError(null);
        }
      } catch {
        if (seq === requestSeq.current) setError(t('couldNotReach'));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [address, t],
  );

  useEffect(() => {
    void load(interval, true);

    // Refresh in the background, without the spinner: replacing a drawn chart
    // with a skeleton every minute would be worse than a slightly old chart.
    const timer = window.setInterval(() => void load(interval, false), REFRESH_MS[interval]);
    return () => window.clearInterval(timer);
  }, [interval, load]);

  const candles = data?.candles ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={interval} onValueChange={(value) => setInterval(value as CandleInterval)}>
          <TabsList>
            {CANDLE_INTERVALS.map((value) => (
              <TabsTrigger key={value} value={value}>
                {LABELS[value]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {data?.stale ? (
          <Badge tone="warning">{t('cachedPrices')}</Badge>
        ) : data?.pool ? (
          <span className="text-[11px] text-[var(--text-subtle)]">
            {data.pool.dex.replace(/-/g, ' ')}
            {data.pool.quoteSymbol ? ` · ${symbol}/${data.pool.quoteSymbol}` : ''}
          </span>
        ) : null}
      </div>

      {loading && candles.length === 0 ? (
        <Skeleton className="h-[380px] w-full" />
      ) : error && candles.length === 0 ? (
        <EmptyState
          icon={<AlertCircle className="size-5" />}
          title={t('unavailableTitle')}
          description={error}
        />
      ) : data && !data.available ? (
        <EmptyState
          icon={<LineChart className="size-5" />}
          title={t('noChartTitle')}
          description={t('noChartBody', { symbol })}
        />
      ) : candles.length === 0 ? (
        <EmptyState
          icon={<LineChart className="size-5" />}
          title={t('noHistoryTitle')}
          description={t('noHistoryBody')}
        />
      ) : (
        <PriceChart
          candles={candles}
          interval={interval}
          precision={precisionFor(candles)}
        />
      )}

      {data?.source && candles.length > 0 ? (
        <p className={cn('text-[11px] leading-relaxed text-[var(--text-subtle)]')}>
          {t('sourceNote', { source: data.source })}
          {data.fetchedAt
            ? t('retrievedAt', { when: new Date(data.fetchedAt).toLocaleTimeString(locale) })
            : ''}
          {t('historicNote')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Decimal places for the price axis.
 *
 * Driven by magnitude, because one fixed precision cannot serve both a
 * $3,000 asset and a token priced at $0.0000004: two decimals would flatten the
 * second to a straight line at zero.
 */
function precisionFor(candles: Candle[]): number {
  const last = candles[candles.length - 1]?.close ?? 1;
  if (last >= 1_000) return 2;
  if (last >= 1) return 4;
  if (last >= 0.01) return 5;
  if (last >= 0.0001) return 6;
  return 8;
}
