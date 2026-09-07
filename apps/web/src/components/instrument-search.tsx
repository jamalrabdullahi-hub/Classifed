'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { cn } from '@flt/ui';
import { get } from '@/lib/api';

/**
 * Search across everything tradeable.
 *
 * Spot and perpetuals come back from one endpoint, ranked together, because a
 * person typing "SOL" wants the instrument and does not know or care which
 * table it lives in. The result says which it is; the routing follows from
 * that rather than from a filter the user had to set first.
 *
 * Server-side rather than client-side: there are 2,675 spot tokens on Base
 * alone, and shipping that list to the browser to filter it would cost more
 * than the search it replaces.
 */

interface Result {
  kind: 'spot' | 'perp';
  symbol: string;
  name: string;
  href: string;
  detail: string;
  tier: string | null;
  address: string | null;
  /** Another enabled token shares this symbol. */
  ambiguous: boolean;
}

export function InstrumentSearch({
  placeholder = 'Search markets',
  className = '',
  autoFocus = false,
}: {
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef(0);

  // Debounced: a query fires on a keystroke pause rather than on every key, so
  // typing a four-letter symbol is one request and not four.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }

    const token = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const data = await get<{ results: Result[] }>(
          `/api/search?q=${encodeURIComponent(trimmed)}&limit=20`,
        );
        // Out-of-order responses would show results for a query the user has
        // already moved past.
        if (token === latest.current) {
          setResults(data.results);
          setHighlighted(0);
        }
      } catch {
        if (token === latest.current) setResults([]);
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function go(result: Result) {
    setOpen(false);
    setQuery('');
    router.push(result.href);
  }

  return (
    <div ref={container} className={cn('relative', className)}>
      <div className="flex items-center gap-1.5 rounded-[var(--radius)] border border-[var(--border)] px-2 py-1 focus-within:border-[var(--text-muted)]">
        <Search className="size-3 shrink-0 text-[var(--text-subtle)]" />
        <input
          value={query}
          autoFocus={autoFocus}
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
              if (chosen) go(chosen);
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          aria-label="Search instruments"
          aria-expanded={open}
          role="combobox"
          aria-controls="instrument-search-results"
          className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[11px] text-[var(--text)] outline-none placeholder:text-[var(--text-subtle)]"
        />
      </div>

      {open && query.trim() && results.length === 0 ? (
        <div className="absolute right-0 z-40 mt-1 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--canvas)] px-2.5 py-2 text-[10.5px] text-[var(--text-subtle)] shadow-lg">
          Nothing matches “{query.trim()}”.
        </div>
      ) : null}

      {open && results.length > 0 ? (
        <ul
          id="instrument-search-results"
          role="listbox"
          className="absolute right-0 z-40 mt-1 max-h-80 w-full min-w-64 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--canvas)] py-1 shadow-lg"
        >
          {results.map((result, index) => (
            <li key={`${result.kind}-${result.symbol}-${result.href}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => go(result)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left transition-colors',
                  index === highlighted ? 'bg-[var(--surface-raised)]' : '',
                )}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--text)]">
                    {result.symbol}
                  </span>
                  <span className="truncate text-[10px] text-[var(--text-subtle)]">
                    {result.name}
                  </span>
                  {/*
                    Two tokens on Base are both called BTC and neither is
                    Bitcoin. Where a symbol collides the address is the only
                    thing that tells them apart, so it is shown rather than
                    left for the trade page — by then the choice is made.
                  */}
                  {result.ambiguous && result.address ? (
                    <span className="shrink-0 font-[family-name:var(--font-mono)] text-[9px] text-[var(--text-subtle)]">
                      {result.address.slice(0, 6)}…{result.address.slice(-4)}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {/*
                    An unreviewed token is flagged here rather than only on the
                    trade page: the scanner is where somebody picks the wrong
                    lookalike, and by the trade page they have already chosen.
                  */}
                  {result.tier === 'UNVERIFIED' || result.tier === 'RECOGNIZED' ? (
                    <span className="text-[9px] uppercase tracking-[0.06em] text-[var(--warning)]">
                      {result.tier === 'UNVERIFIED' ? 'unverified' : 'unreviewed'}
                    </span>
                  ) : null}
                  <span className="text-[9.5px] text-[var(--text-subtle)]">{result.detail}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
