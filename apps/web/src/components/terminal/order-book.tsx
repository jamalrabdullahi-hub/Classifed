'use client';

import { useEffect, useState } from 'react';
import { cn } from '@flt/ui';
import { ApiError, get } from '@/lib/api';

/**
 * The order book ladder.
 *
 * Three decisions worth recording.
 *
 * **Asks are rendered best-last.** The book reads outward from the spread in
 * both directions, so the best ask sits immediately above the mark and the best
 * bid immediately below it. Rendering asks in plain ascending order would put
 * the cheapest offer at the top of the panel, furthest from the price it is
 * closest to.
 *
 * **Depth shading is relative to the whole book, not to each side.** Shading
 * each side against its own maximum makes a thin side look as deep as a heavy
 * one, which inverts the single most useful thing a ladder tells you at a
 * glance: which way the weight sits.
 *
 * **Order count is shown.** One resting order for forty contracts and forty
 * orders for one behave completely differently when price arrives, and a ladder
 * showing only aggregate size hides that distinction entirely.
 *
 * Green and red here are information rather than decoration: in a book, side is
 * the data, which is the exception the monochrome rule was always written to
 * allow.
 */

interface Level {
  price: string;
  size: string;
  total: string;
  ratio: number;
  orderCount: number | null;
}

interface Book {
  symbol: string;
  bids: Level[];
  asks: Level[];
  bestBid: string | null;
  bestAsk: string | null;
  spread: string | null;
  capturedAt: string;
}

export function OrderBook({
  symbol,
  depth = 11,
  markPrice = null,
  onPriceClick,
  emptyNote = null,
}: {
  symbol: string;
  depth?: number;
  /** What positions are marked against. Shown in the band between the sides. */
  markPrice?: string | null;
  onPriceClick?: (price: string) => void;
  /**
   * Shown instead of an empty ladder when the venue has no book at all.
   *
   * Ostium fills against an oracle with a spread rather than resting orders, so
   * there are genuinely no levels. An empty grid with no explanation reads as a
   * broken panel, and the fix is to say which it is.
   */
  emptyNote?: string | null;
}) {
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await get<Book>(`/api/perps/markets/${symbol}/book?depth=${depth}`);
        if (!cancelled) {
          setBook(next);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : 'Book unavailable');
        }
      }
    }

    void load();
    const timer = setInterval(() => void load(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbol, depth]);

  if (error && !book) {
    return <PanelMessage>{error}</PanelMessage>;
  }
  if (!book) {
    return <PanelMessage>Loading book…</PanelMessage>;
  }

  const hasLevels = (book?.bids.length ?? 0) > 0 || (book?.asks.length ?? 0) > 0;

  if (emptyNote && book && !hasLevels) {
    return (
      <div className="flex h-full flex-col">
        <p className="p-4 text-center text-[11px] leading-relaxed text-[var(--text-subtle)]">
          {emptyNote}
        </p>
        {markPrice ? (
          <p className="border-t border-[var(--border)] px-2.5 py-1.5 text-center font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)]">
            {markPrice}
            <span className="ml-1.5 text-[10px] text-[var(--text-subtle)]">mark</span>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col text-[11px]">
      <div className="grid grid-cols-[1fr_1fr_1fr] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[9.5px] uppercase tracking-[0.09em] text-[var(--text-subtle)]">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>

      <div className="flex flex-1 flex-col justify-end">
        {[...book.asks].reverse().map((level) => (
          <Row key={`a${level.price}`} level={level} side="ask" onClick={onPriceClick} />
        ))}
      </div>

      {/* The band carries the mark price, not the best ask.
          Showing the best ask here repeats the row directly above it and wastes
          the most prominent line in the panel on a number already on screen —
          while omitting the one figure the position is actually marked and
          liquidated against. */}
      <div className="my-0.5 flex items-baseline justify-between border-y border-[var(--border)] px-2.5 py-1.5">
        <span className="font-[family-name:var(--font-mono)] text-[13px] font-semibold text-[var(--text)]">
          {markPrice ?? book.bestAsk ?? '—'}
        </span>
        <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-subtle)]">
          {markPrice ? 'mark' : 'best ask'} · spread {book.spread ?? '—'}
        </span>
      </div>

      <div className="flex flex-1 flex-col">
        {book.bids.map((level) => (
          <Row key={`b${level.price}`} level={level} side="bid" onClick={onPriceClick} />
        ))}
      </div>
    </div>
  );
}

function Row({
  level,
  side,
  onClick,
}: {
  level: Level;
  side: 'bid' | 'ask';
  onClick?: (price: string) => void;
}) {
  const content = (
    <>
      <span
        className={cn(
          'relative z-10 font-[family-name:var(--font-mono)]',
          side === 'bid' ? 'text-[var(--positive)]' : 'text-[var(--negative)]',
        )}
      >
        {level.price}
      </span>
      <span className="relative z-10 text-right font-[family-name:var(--font-mono)] text-[var(--text-muted)]">
        {trim(level.size)}
      </span>
      <span
        className="relative z-10 text-right font-[family-name:var(--font-mono)] text-[var(--text-subtle)]"
        title={level.orderCount ? `${level.orderCount} orders resting` : undefined}
      >
        {trim(level.total)}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-y-0 right-0 z-0',
          side === 'bid' ? 'bg-[var(--positive)]/12' : 'bg-[var(--negative)]/12',
        )}
        style={{ width: `${Math.max(1, level.ratio * 100)}%` }}
      />
    </>
  );

  const className =
    'relative grid w-full grid-cols-[1fr_1fr_1fr] px-2.5 py-[2px] leading-[1.45]';

  // Clicking a level fills the ticket's price. Only interactive when the parent
  // wants it, so the book stays a plain readout where it is only being read.
  if (!onClick) {
    return <div className={className}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => onClick(level.price)}
      className={cn(className, 'text-left hover:bg-[var(--surface-raised)]')}
      aria-label={`Use ${level.price} as the order price`}
    >
      {content}
    </button>
  );
}

function PanelMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-[11px] text-[var(--text-subtle)]">
      {children}
    </div>
  );
}

/** Trailing zeros carry no information in a ladder and cost horizontal space. */
function trim(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  const [whole, fraction] = trimmed.split('.');
  if (!fraction) return whole ?? trimmed;
  return `${whole}.${fraction.slice(0, 4)}`;
}
