'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button, cn } from '@flt/ui';
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
  level2Locked = false,
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
  /** FREE/guest: show a static blurred teaser instead of the live ladder. */
  level2Locked?: boolean;
}) {
  const t = useTranslations('orderBookPanel');
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (level2Locked) return;
    let cancelled = false;

    async function load() {
      try {
        const next = await get<Book>(`/api/perps/markets/${encodeURIComponent(symbol)}/book?depth=${depth}`);
        if (!cancelled) {
          setBook(next);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : t('bookUnavailable'));
        }
      }
    }

    void load();
    const timer = setInterval(() => void load(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbol, depth, level2Locked]);

  if (level2Locked) {
    return <LockedLevel2 />;
  }

  if (error && !book) {
    return <PanelMessage>{error}</PanelMessage>;
  }
  if (!book) {
    return <PanelMessage>{t('loadingBook')}</PanelMessage>;
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
        <span>{t('price')}</span>
        <span className="text-right">{t('size')}</span>
        <span className="text-right">{t('total')}</span>
      </div>

      <div className="flex flex-1 flex-col justify-end">
        {[...book.asks].reverse().map((level) => (
          <Row key={`a${level.price}`} level={level} side="ask" onClick={onPriceClick} t={t} />
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
          {markPrice ? t('mark') : t('bestAsk')}
          {t('spread', { spread: book.spread ?? '—' })}
        </span>
      </div>

      <div className="flex flex-1 flex-col">
        {book.bids.map((level) => (
          <Row key={`b${level.price}`} level={level} side="bid" onClick={onPriceClick} t={t} />
        ))}
      </div>
    </div>
  );
}

function Row({
  level,
  side,
  onClick,
  t,
}: {
  level: Level;
  side: 'bid' | 'ask';
  onClick?: (price: string) => void;
  t: ReturnType<typeof useTranslations<'orderBookPanel'>>;
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
        title={level.orderCount ? t('ordersResting', { count: level.orderCount }) : undefined}
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
      aria-label={t('usePriceAria', { price: level.price })}
    >
      {content}
    </button>
  );
}

/**
 * Level 2, locked.
 *
 * A static, deliberately-unreadable mock of the ladder — the *shape* of Level 2
 * without the data — behind an upsell. FREE and guests get this; BASIC and
 * above get the live book. It does not fetch, so a locked reader costs the venue
 * nothing.
 */
function LockedLevel2() {
  const rows = [
    { p: '1.0918', s: '2.41', t: '8.72' },
    { p: '1.0916', s: '1.10', t: '6.31' },
    { p: '1.0914', s: '3.82', t: '5.21' },
    { p: '1.0912', s: '0.94', t: '1.39' },
    { p: '1.0910', s: '5.02', t: '0.45' },
  ];

  return (
    <div className="relative h-full overflow-hidden text-[11px]">
      <div className="select-none blur-[3px]" aria-hidden="true">
        <div className="grid grid-cols-[1fr_1fr_1fr] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[9.5px] uppercase tracking-[0.09em] text-[var(--text-subtle)]">
          <span>Price</span>
          <span className="text-right">Size</span>
          <span className="text-right">Total</span>
        </div>
        {rows.map((row) => (
          <div
            key={row.p}
            className="grid grid-cols-[1fr_1fr_1fr] px-2.5 py-[2px] font-[family-name:var(--font-mono)] text-[var(--negative)]"
          >
            <span>{row.p}</span>
            <span className="text-right text-[var(--text-muted)]">{row.s}</span>
            <span className="text-right text-[var(--text-subtle)]">{row.t}</span>
          </div>
        ))}
        <div className="my-0.5 border-y border-[var(--border)] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[13px] font-semibold text-[var(--text)]">
          1.0920
        </div>
        {[...rows].reverse().map((row) => (
          <div
            key={`b${row.p}`}
            className="grid grid-cols-[1fr_1fr_1fr] px-2.5 py-[2px] font-[family-name:var(--font-mono)] text-[var(--positive)]"
          >
            <span>{row.p}</span>
            <span className="text-right text-[var(--text-muted)]">{row.s}</span>
            <span className="text-right text-[var(--text-subtle)]">{row.t}</span>
          </div>
        ))}
      </div>

      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-[var(--canvas)]/70 px-4 text-center">
        <p className="max-w-[82%] text-[12px] font-medium leading-snug text-[var(--text)]">
          Enhance your trading with Level 2 data
        </p>
        <Button asChild variant="primary" size="sm">
          <Link href="/qorshayaal">Buy here</Link>
        </Button>
      </div>
    </div>
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
