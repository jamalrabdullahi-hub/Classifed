'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PerpChart } from './perp-chart';
import { OrderBook } from './order-book';
import { TradeTape } from './trade-tape';
import { TickerStrip, type TickerMarket } from './ticker-strip';
import { ProtectionPanel } from './protection-panel';
import { ProtectedTicket } from './protected-ticket';
import type { PriceLineSpec } from '@/components/price-chart';
import { PerpPositionsPanel } from '@/components/perp-positions';

/**
 * The trading terminal.
 *
 * A fixed three-column grid rather than a responsive reflow, because the layout
 * *is* the product here: chart, book and ticket have to be visible at the same
 * time or the density buys nothing. Below the breakpoint the panels stack in
 * priority order instead — ticket, chart, book, tape — which is a different
 * screen honestly rather than the same screen crushed.
 *
 * Panels own their own polling. They refresh at different rates because they
 * decay at different rates: the book is stale in two seconds, a daily candle is
 * not stale in five minutes, and coupling them to one timer would either hammer
 * the venue or show an old book.
 */
export function PerpTerminal({
  market,
  markets,
  venueName,
  venueIsMock,
  canTrade = true,
  guest = false,
  requiresBridgedCollateral,
  level2Locked = false,
  tier = 'FREE',
}: {
  market: TickerMarket;
  markets: Array<{ symbol: string; name?: string }>;
  venueName: string;
  venueIsMock: boolean;
  /** False on a plan without perpetuals: everything renders, nothing submits. */
  canTrade?: boolean;
  /** No session at all. Locks the ticket for a different reason than `canTrade`, and skips the position panel — there is no account to hold one. */
  guest?: boolean;
  requiresBridgedCollateral: boolean;
  /** BASIC+ see the live Level 2 book; FREE/guests get a blurred teaser. */
  level2Locked?: boolean;
  /** Subscription tier, for gating the indicator set. */
  tier?: string;
}) {
  const t = useTranslations('terminal');
  // Clicking a book level is currently read by nothing: the protected ticket
  // is market-only, because a limit order and a first-hit policy would start
  // at two different reference prices and the premium would be quoted against
  // a price the position never opened at.
  const [, setPriceFromBook] = useState<string | null>(null);

  // The ticket computes the boundary as the participant changes cover; the
  // chart draws it. Held here because the two are siblings and neither should
  // own the other, exactly as with the book's click-to-price.
  const [protectionLines, setProtectionLines] = useState<PriceLineSpec[]>([]);

  /**
   * The take-profit / stop-loss levels being edited on an open position.
   *
   * Held beside the protection lines rather than merged into them because they
   * come from a different sibling and have a different life: cover's boundary
   * moves as the ticket is changed, these move as a position is managed, and
   * either can be present without the other.
   */
  const [bracketLines, setBracketLines] = useState<PriceLineSpec[]>([]);
  const chartLines = useMemo(
    () => [...protectionLines, ...bracketLines],
    [protectionLines, bracketLines],
  );

  /**
   * Where the chart's data came from, when it is not the trading venue.
   *
   * Ostium publishes no history, so its charts are drawn from the underlying's
   * own market. Attribution is not a formality here: metals are charted from
   * the front-month future, which carries a basis over the spot the contract
   * marks against, and the reader should be able to see why the line sits
   * slightly above the mark.
   */
  const historyNote =
    market.assetClass === 'CRYPTO'
      ? null
      : t('chartFromUnderlying', { venue: venueName }) +
        (market.assetClass === 'COMMODITY'
          ? t('metalsNote')
          : t('ownOracleNote', { venue: venueName }));

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--canvas)]">
      <TickerStrip market={market} markets={markets} venueName={venueName} />

      {venueIsMock ? (
        <p className="border-b border-[var(--border)] bg-[var(--warning)]/10 px-3 py-1.5 text-[11px] text-[var(--warning)]">
          {t('simulatedVenue')}
        </p>
      ) : null}

      {/*
        One frame, on desktop.

        The row used to size to its tallest column, and the ticket is the
        tallest: every section expanded pushed the whole row down, leaving the
        chart and book stranded above a widening band of empty space — the
        "spacing" that grew as options were selected. The row now has a fixed
        height, each column scrolls inside it, and the ticket column is wider so
        less of it needs to.
      */}
      <div className="grid lg:h-[720px] lg:grid-cols-[minmax(0,1fr)_180px_360px]">
        <Panel label={t('chartLabel', { symbol: market.symbol })} className="order-2 lg:order-1 min-h-[380px]">
          <PerpChart
            symbol={market.symbol}
            height={520}
            priceLines={chartLines}
            historyNote={historyNote}
            tier={tier}
          />
        </Panel>

        <Panel
          label={t('orderBook')}
          className="order-3 border-t lg:order-2 lg:border-l lg:border-t-0"
          bodyClassName="overflow-y-auto"
        >
          <OrderBook
            emptyNote={
              market.assetClass === 'CRYPTO'
                ? null
                : t('noOrderBookNote', { venue: venueName })
            }
            symbol={market.symbol}
            depth={11}
            markPrice={market.markPrice}
            onPriceClick={setPriceFromBook}
            level2Locked={level2Locked}
          />
        </Panel>

        <Panel
          label={t('order')}
          className="order-1 lg:order-3 lg:border-l"
          bodyClassName="p-0 lg:overflow-y-auto"
        >
          <ProtectedTicket
            locked={guest || !canTrade}
            lockReason={guest ? 'guest' : 'plan'}
            onPriceLinesChange={setProtectionLines}
            symbol={market.symbol}
            markPrice={market.markPrice}
            minSize={market.minSize}
            maxLeverage={market.maxLeverage}
            venueMaxLeverage={market.venueMaxLeverage}
          />
        </Panel>
      </div>

      <div className="grid border-t border-[var(--border)] lg:grid-cols-[minmax(0,1fr)_180px_360px]">
        <Panel label={t('yourPosition')} className="min-h-[120px]">
          {guest ? (
            <p className="p-3 text-[11px] text-[var(--text-subtle)]">{t('signInForPositions')}</p>
          ) : (
            <PerpPositionsPanel
              compact
              symbol={market.symbol}
              onBracketLinesChange={setBracketLines}
            />
          )}
        </Panel>

        <Panel label={t('recentTrades')} className="border-t lg:border-l lg:border-t-0">
          <div className="h-[190px]">
            <TradeTape symbol={market.symbol} limit={26} />
          </div>
        </Panel>

        <Panel label={t('costOfHolding')} className="border-t lg:border-l lg:border-t-0">
          <FundingPanel market={market} requiresBridged={requiresBridgedCollateral} venueName={venueName} />
        </Panel>
      </div>

      {/*
        Full width rather than a fourth column: the panel's point is the
        comparison between three policies, and three policies plus their inputs
        do not read in a 264px rail.
      */}
      <Panel label={t('protectionPanelLabel')} className="border-t">
        <ProtectionPanel symbol={market.symbol} markPrice={market.markPrice} />
      </Panel>
    </div>
  );
}

function Panel({
  label,
  children,
  className = '',
  bodyClassName = '',
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`flex min-h-0 flex-col border-[var(--border)] ${className}`}>
      <h2 className="border-b border-[var(--border)] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[9.5px] uppercase tracking-[0.1em] text-[var(--text-subtle)]">
        {label}
      </h2>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

function FundingPanel({
  market,
  requiresBridged,
  venueName,
}: {
  market: TickerMarket;
  requiresBridged: boolean;
  venueName: string;
}) {
  const t = useTranslations('terminal');
  const annual = market.fundingRateAnnualised ? Number(market.fundingRateAnnualised) : null;

  return (
    <div className="space-y-2 p-2.5 text-[11px] leading-relaxed">
      <Line
        label={t('rateLabel', { hours: market.fundingIntervalHours })}
        value={
          market.fundingRate
            ? `${Number(market.fundingRate) >= 0 ? '+' : ''}${(Number(market.fundingRate) * 100).toFixed(4)}%`
            : '—'
        }
      />
      <Line
        label={t('annualised')}
        value={annual === null ? '—' : `${annual >= 0 ? '+' : ''}${(annual * 100).toFixed(2)}%`}
      />
      <p className="pt-1 text-[10.5px] text-[var(--text-subtle)]">
        {market.fundingRate && Number(market.fundingRate) >= 0
          ? t('longsPayShorts')
          : t('shortsPayLongs')}
      </p>
      {requiresBridged ? (
        <p className="text-[10.5px] text-[var(--text-subtle)]">
          {t('marginHeldBy', { venue: venueName })}
        </p>
      ) : null}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="font-[family-name:var(--font-mono)] text-[var(--text)]">{value}</span>
    </div>
  );
}
