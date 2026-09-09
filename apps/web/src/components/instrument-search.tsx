'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
}

interface Group {
  key: string;
  label: string;
  results: Result[];
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
  const t = useTranslations('instrumentSearch');
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef(0);

  // Debounced: a query fires on a keystroke pause rather than on every key, so
  // typing a four-letter symbol is one request and not four.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setGroups([]);
      return;
    }

    const token = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const data = await get<{ groups: Group[] }>(
          `/api/search?q=${encodeURIComponent(trimmed)}&limit=24`,
        );
        // Out-of-order responses would show results for a query the user has
        // already moved past.
        if (token === latest.current) {
          setGroups(data.groups);
          setHighlighted(0);
        }
      } catch {
        if (token === latest.current) setGroups([]);
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

  /**
   * The grouped results as one sequence.
   *
   * Rendering is grouped but arrow-key navigation is not: a reader moving down
   * the list expects to cross a heading into the next section, not to stop at
   * it. The headings are labels, not stops.
   */
  const flat = groups.flatMap((group) => group.results);

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
              setHighlighted((index) => Math.min(index + 1, flat.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlighted((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const chosen = flat[highlighted];
              if (chosen) go(chosen);
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          aria-label={t('searchAria')}
          aria-expanded={open}
          role="combobox"
          aria-controls="instrument-search-results"
          className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[11px] text-[var(--text)] outline-none placeholder:text-[var(--text-subtle)]"
        />
      </div>

      {open && query.trim() && flat.length === 0 ? (
        <div className="absolute right-0 z-40 mt-1 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--canvas)] px-2.5 py-2 text-[10.5px] text-[var(--text-subtle)] shadow-lg">
          {t('nothingMatches', { query: query.trim() })}
        </div>
      ) : null}

      {open && flat.length > 0 ? (
        <div
          id="instrument-search-results"
          role="listbox"
          className="absolute right-0 z-40 mt-1 max-h-96 w-full min-w-64 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--canvas)] py-1 shadow-lg"
        >
          {groups.map((group) => (
            <div key={group.key}>
              {/* A heading, not an option: it names the section and is skipped
                  by arrow-key navigation. */}
              <p
                role="presentation"
                className="px-2.5 pb-0.5 pt-1.5 text-[9px] font-medium uppercase tracking-[0.08em] text-[var(--text-subtle)]"
              >
                {group.label}
              </p>
              <ul>
                {group.results.map((result) => {
                  const index = flat.indexOf(result);
                  return (
                    <li key={`${result.kind}-${result.href}`}>
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
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {/*
                            An unreviewed token is flagged here rather than only
                            on the trade page: the scanner is where somebody
                            picks the wrong lookalike, and by the trade page they
                            have already chosen.
                          */}
                          {result.tier === 'UNVERIFIED' || result.tier === 'RECOGNIZED' ? (
                            <span className="text-[9px] uppercase tracking-[0.06em] text-[var(--warning)]">
                              {result.tier === 'UNVERIFIED' ? t('unverified') : t('unreviewed')}
                            </span>
                          ) : null}
                          <span className="text-[9.5px] text-[var(--text-subtle)]">
                            {result.detail}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
