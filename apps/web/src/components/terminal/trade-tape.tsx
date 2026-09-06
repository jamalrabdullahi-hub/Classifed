'use client';

import { useEffect, useState } from 'react';
import { cn } from '@flt/ui';
import { get } from '@/lib/api';

/**
 * The trade tape.
 *
 * Colour marks the aggressor — green when a trade lifted an offer, red when it
 * hit a bid — which is the only thing a tape is read for at a glance: whether
 * buyers or sellers are the ones crossing the spread.
 *
 * The venue publishes both counterparties on every trade. Those are stripped in
 * the adapter and there is no field for them on the way here, so a public price
 * feed cannot quietly become a way to watch who is trading.
 */

interface Trade {
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  at: string;
}

export function TradeTape({ symbol, limit = 26 }: { symbol: string; limit?: number }) {
  const [trades, setTrades] = useState<Trade[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await get<{ trades: Trade[] }>(
          `/api/perps/markets/${symbol}/trades?limit=${limit}`,
        );
        if (!cancelled) setTrades(next.trades);
      } catch {
        // A tape that stops updating is better than one that clears itself and
        // implies the market went quiet.
      }
    }

    void load();
    const timer = setInterval(() => void load(), 2_500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbol, limit]);

  return (
    <div className="flex h-full flex-col text-[11px]">
      <div className="grid grid-cols-[1.1fr_0.9fr_0.7fr] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[9.5px] uppercase tracking-[0.09em] text-[var(--text-subtle)]">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Time</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {trades === null ? (
          <p className="p-3 text-center text-[11px] text-[var(--text-subtle)]">Loading…</p>
        ) : trades.length === 0 ? (
          <p className="p-3 text-center text-[11px] text-[var(--text-subtle)]">No recent trades</p>
        ) : (
          trades.map((trade, index) => (
            <div
              key={`${trade.at}-${index}`}
              className="grid grid-cols-[1.1fr_0.9fr_0.7fr] px-2.5 py-[2px] font-[family-name:var(--font-mono)] leading-[1.45]"
            >
              <span
                className={cn(
                  trade.side === 'BUY' ? 'text-[var(--positive)]' : 'text-[var(--negative)]',
                )}
              >
                {trade.price}
              </span>
              <span className="text-right text-[var(--text-muted)]">{trim(trade.size)}</span>
              <span className="text-right text-[var(--text-subtle)]">{clock(trade.at)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function trim(value: string): string {
  if (!value.includes('.')) return value;
  const [whole, fraction] = value.replace(/0+$/, '').replace(/\.$/, '').split('.');
  if (!fraction) return whole ?? value;
  return `${whole}.${fraction.slice(0, 4)}`;
}
