'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { cn } from '@flt/ui';

/**
 * Ticker search.
 *
 * The strip used to render every offered market as a link, which worked while
 * there were three. With the venue's full list that is a wall of two hundred
 * tickers above the chart, and the one you want is never the one in front of
 * you. So: type to filter, arrows to move, enter to go.
 *
 * Ranked rather than merely filtered. An exact symbol match comes first, then a
 * symbol prefix, then anything containing the query in symbol or name —
 * otherwise typing "BTC" surfaces every market whose *name* mentions bitcoin
 * before Bitcoin itself.
 */

export interface SearchableMarket {
  symbol: string;
  name?: string;
}

export function MarketSearch({
  markets,
  current,
}: {
  markets: SearchableMarket[];
  current: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const container = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const needle = query.trim().toUpperCase();
    if (!needle) return markets.slice(0, 12);

    return markets
      .map((market) => {
        const symbol = market.symbol.toUpperCase();
        const name = (market.name ?? '').toUpperCase();

        // Lower is better.
        if (symbol === needle) return { market, rank: 0 };
        if (symbol.startsWith(needle)) return { market, rank: 1 };
        if (name.startsWith(needle)) return { market, rank: 2 };
        if (symbol.includes(needle)) return { market, rank: 3 };
        if (name.includes(needle)) return { market, rank: 4 };
        return null;
      })
      .filter((entry): entry is { market: SearchableMarket; rank: number } => entry !== null)
      .sort((a, b) => a.rank - b.rank || a.market.symbol.localeCompare(b.market.symbol))
      .slice(0, 12)
      .map((entry) => entry.market);
  }, [markets, query]);

  // Reset the cursor whenever the list changes underneath it, or the highlight
  // ends up pointing past the end of a shorter list.
  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  // Close on an outside click. Without this the panel stays open behind the
  // rest of the terminal and swallows the next click.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function go(symbol: string) {
    setOpen(false);
    setQuery('');
    router.push(`/perps/${symbol}`);
  }

  return (
    <div ref={container} className="relative ml-auto w-52">
      <div className="flex items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] px-2 py-1 focus-within:border-[var(--text-muted)]">
        <Search className="size-3 shrink-0 text-[var(--text-subtle)]" />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setHighlighted((index) => Math.min(index + 1, results.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlighted((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const chosen = results[highlighted];
              if (chosen) go(chosen.symbol);
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder={`Search ${markets.length} markets`}
          aria-label="Search markets"
          aria-expanded={open}
          role="combobox"
          aria-controls="market-search-results"
          className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[11px] text-[var(--text)] outline-none placeholder:text-[var(--text-subtle)]"
        />
      </div>

      {open && results.length > 0 ? (
        <ul
          id="market-search-results"
          role="listbox"
          className="absolute right-0 z-40 mt-1 max-h-72 w-full overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--canvas)] py-1 shadow-lg"
        >
          {results.map((market, index) => (
            <li key={market.symbol}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => go(market.symbol)}
                className={cn(
                  'flex w-full items-baseline justify-between gap-2 px-2.5 py-1.5 text-left transition-colors',
                  index === highlighted ? 'bg-[var(--surface-raised)]' : '',
                )}
              >
                <span
                  className={cn(
                    'font-[family-name:var(--font-mono)] text-[11.5px]',
                    market.symbol === current ? 'text-[var(--text)]' : 'text-[var(--text-muted)]',
                  )}
                >
                  {market.symbol}
                </span>
                {market.name && market.name !== market.symbol ? (
                  <span className="truncate text-[10px] text-[var(--text-subtle)]">
                    {market.name}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
