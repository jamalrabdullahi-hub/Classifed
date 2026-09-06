'use client';

import { useState } from 'react';
import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from '@flt/ui';
import { MarketChart } from '@/components/market-chart';

/**
 * A chart for browsing prices without being able to trade yet.
 *
 * The trade screen replaces itself entirely with a notice whenever the user is
 * gated — awaiting verification, no wallet linked, trading disabled — which
 * means someone still being onboarded sees no market data anywhere on the
 * screen that exists to show them a market.
 *
 * The gate is right to block execution. It should not also block looking:
 * deciding what you want to trade comes before connecting a wallet, and a
 * product that hides prices until you have finished paperwork gives you no
 * reason to finish the paperwork.
 */

export interface PreviewToken {
  address: string;
  symbol: string;
  name: string;
  verificationTier: string;
}

/**
 * Dollar proxies, which make a poor default chart.
 *
 * Charting a stablecoin against the dollar draws a flat line, and the registry
 * happens to list DAI first — so the first thing the screen showed was the one
 * chart that says nothing. The list still contains them; they are just not what
 * opens.
 */
const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDBC', 'PYUSD', 'FRAX', 'LUSD']);

/** Opened first when present, in this order: the assets people actually watch. */
const PREFERRED = ['CBBTC', 'WETH', 'ETH', 'CBETH', 'AERO'];

function pickDefault(tokens: PreviewToken[]): PreviewToken | null {
  for (const symbol of PREFERRED) {
    const match = tokens.find((token) => token.symbol.toUpperCase() === symbol);
    if (match) return match;
  }
  return tokens.find((token) => !STABLE_SYMBOLS.has(token.symbol.toUpperCase())) ?? tokens[0] ?? null;
}

export function MarketPreview({ tokens }: { tokens: PreviewToken[] }) {
  const [selected, setSelected] = useState<PreviewToken | null>(() => pickDefault(tokens));

  if (!selected) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{selected.symbol} price</CardTitle>
        <Badge tone="neutral">Market data</Badge>
      </CardHeader>

      <CardContent className="space-y-3">
        {tokens.length > 1 ? (
          <div className="flex flex-wrap gap-1">
            {tokens.map((token) => (
              <button
                key={token.address}
                type="button"
                onClick={() => setSelected(token)}
                aria-pressed={token.address === selected.address}
                className={cn(
                  'rounded-[var(--radius-sm)] px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors',
                  token.address === selected.address
                    ? 'bg-[var(--surface-raised)] text-[var(--text)]'
                    : 'text-[var(--text-subtle)] hover:text-[var(--text-muted)]',
                )}
              >
                {token.symbol}
              </button>
            ))}
          </div>
        ) : null}

        <MarketChart address={selected.address} symbol={selected.symbol} />

        <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">
          Prices come from the on-chain pools FLT routes through. They are not quotes — the price
          your trade executes at is fixed when you request one.
        </p>
      </CardContent>
    </Card>
  );
}
