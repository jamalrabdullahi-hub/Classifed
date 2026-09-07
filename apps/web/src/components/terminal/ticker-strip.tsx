'use client';

import { cn } from '@flt/ui';
import { InstrumentSearch } from '@/components/instrument-search';
import type { SearchableMarket } from './market-search';

/**
 * The instrument header.
 *
 * Every figure a leveraged trader checks before sizing an order, on one line:
 * what it is marked at, what the index says, what holding it costs per hour and
 * per year, and the ceiling FLT will actually allow.
 *
 * Mark and index sit next to each other deliberately. They are usually within a
 * basis point, and the moment they are not is the moment funding is about to
 * move — showing only one hides the most informative disagreement on the page.
 */

export interface TickerMarket {
  symbol: string;
  name: string;
  markPrice: string | null;
  indexPrice: string | null;
  fundingRate: string | null;
  fundingRateAnnualised: string | null;
  fundingIntervalHours: number;
  openInterest: string | null;
  maxLeverage: number;
  venueMaxLeverage: number;
  minSize: string;
}

export function TickerStrip({
  market,
  markets,
  venueName,
}: {
  market: TickerMarket;
  markets: SearchableMarket[];
  venueName: string;
}) {
  const funding = market.fundingRate ? Number(market.fundingRate) : null;
  const annual = market.fundingRateAnnualised ? Number(market.fundingRateAnnualised) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-[family-name:var(--font-display)] text-[14px] font-semibold text-[var(--text)]">
          {market.symbol}
        </span>
        <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.09em] text-[var(--text-subtle)]">
          perp
        </span>
      </div>

      <Stat label="Mark" value={price(market.markPrice)} emphasis />
      <Stat label="Index" value={price(market.indexPrice)} />
      <Stat
        label={`Funding / ${market.fundingIntervalHours}h`}
        value={funding === null ? '—' : `${signed(funding * 100, 4)}%`}
        tone={funding === null ? undefined : funding >= 0 ? 'positive' : 'negative'}
      />
      <Stat
        label="Funding / yr"
        value={annual === null ? '—' : `${signed(annual * 100, 2)}%`}
        tone={annual === null ? undefined : annual >= 0 ? 'positive' : 'negative'}
      />
      <Stat label="Open interest" value={compact(market.openInterest)} />
      <Stat
        label="Max leverage"
        value={`${market.maxLeverage}×`}
        hint={
          market.venueMaxLeverage > market.maxLeverage
            ? `${venueName} allows ${market.venueMaxLeverage}×; FLT caps it here`
            : undefined
        }
      />

      <InstrumentSearch
        className="ml-auto w-56"
        placeholder={`Search ${markets.length} perps and spot`}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  emphasis,
  hint,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative';
  emphasis?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-px whitespace-nowrap" title={hint}>
      <span className="font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.09em] text-[var(--text-subtle)]">
        {label}
      </span>
      <span
        className={cn(
          'font-[family-name:var(--font-mono)]',
          emphasis ? 'text-[12.5px] font-semibold' : 'text-[11.5px]',
          tone === 'positive'
            ? 'text-[var(--positive)]'
            : tone === 'negative'
              ? 'text-[var(--negative)]'
              : 'text-[var(--text)]',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function price(value: string | null): string {
  if (!value) return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: amount >= 1000 ? 1 : 2,
    maximumFractionDigits: amount >= 1000 ? 1 : 6,
  });
}

/** Keeps the sign, because on a funding rate the sign says who pays. */
function signed(value: number, places: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(places)}`;
}

function compact(value: string | null): string {
  if (!value) return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return amount.toFixed(2);
}
