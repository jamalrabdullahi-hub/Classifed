'use client';

import { useMemo, useState } from 'react';
import { Notice, cn } from '@flt/ui';

/**
 * The market-maker model.
 *
 * ## Why this is a model and not a bot
 *
 * The engine that produces quotes is real, tested and in `@flt/core`. What is
 * deliberately absent is anything that signs. A maker quotes continuously, which
 * needs a key live on the server — and every other part of this platform is
 * built on the rule that no key exists there. Crossing that line is a decision
 * with security and custody consequences, and it should be made deliberately
 * rather than arrive as a side effect of a feature request.
 *
 * ## Why the assumptions are inputs
 *
 * Fill rate and adverse selection decide whether a book is a business or a slow
 * donation, and neither can be measured before running one. Presenting a single
 * projected number would dress two guesses as a forecast. They are controls, so
 * the operator can see how fast the answer changes when they move — which is
 * the actual finding.
 */

export function MarketMakerModel({
  price,
  dailyVolatilityPct,
  makerFeeBps,
  perpBuilderBps,
  spotFeeBps,
}: {
  price: number;
  dailyVolatilityPct: number;
  makerFeeBps: number;
  perpBuilderBps: number;
  spotFeeBps: number;
}) {
  const [inventoryBtc, setInventoryBtc] = useState('0.5');
  const [halfSpreadBps, setHalfSpreadBps] = useState('13.5');
  const [turnover, setTurnover] = useState('20');
  const [adversePct, setAdversePct] = useState('8');
  const [leverage, setLeverage] = useState('5');
  const [userVolume, setUserVolume] = useState('10000000');

  const model = useMemo(() => {
    const inventory = num(inventoryBtc);
    const halfSpread = num(halfSpreadBps) / 10_000;
    const turns = num(turnover);
    const adverse = num(adversePct) / 100;
    const lev = Math.max(1, num(leverage));

    const maxNotional = inventory * price;
    const margin = maxNotional / lev;
    // Three times margin. A maker running at exactly its requirement is
    // liquidated by the move that filled it.
    const capital = margin * 3;

    const filled = maxNotional * turns;
    // Volatility over a position's holding period, not over a whole day.
    const holdingVol = dailyVolatilityPct / 100 / Math.sqrt(24);

    const gross = filled * halfSpread * 2;
    const adverseCost = filled * holdingVol * adverse;
    const fees = (filled * makerFeeBps) / 10_000 * 2;
    const net = gross - adverseCost - fees;

    // The zero-capital alternative, at the same moment.
    const volume = num(userVolume);
    const perpRevenue = (volume * perpBuilderBps) / 10_000;
    const spotRevenue = (volume * spotFeeBps) / 10_000;

    return {
      maxNotional,
      capital,
      filled,
      gross,
      adverseCost,
      fees,
      net,
      monthlyReturn: capital > 0 ? net / capital : 0,
      perpRevenue,
      spotRevenue,
      /** Capital the maker needs to match the fee revenue, at this return. */
      capitalToMatchFees:
        net > 0 && capital > 0 ? ((perpRevenue + spotRevenue) / (net / capital)) : null,
    };
  }, [
    inventoryBtc,
    halfSpreadBps,
    turnover,
    adversePct,
    leverage,
    userVolume,
    price,
    dailyVolatilityPct,
    makerFeeBps,
    perpBuilderBps,
    spotFeeBps,
  ]);

  const losing = model.net <= 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        {/* ── The maker ─────────────────────────────────────────────────── */}
        <div className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
          <h3 className="text-[13px] font-semibold text-[var(--text)]">Running a book</h3>

          <div className="grid grid-cols-2 gap-2">
            <Input label="Max inventory (BTC)" value={inventoryBtc} onChange={setInventoryBtc} />
            <Input label="Half-spread (bps)" value={halfSpreadBps} onChange={setHalfSpreadBps} />
            <Input label="Leverage" value={leverage} onChange={setLeverage} />
            <Input label="Turnover / month" value={turnover} onChange={setTurnover} />
            <Input
              label="Adverse selection (%)"
              value={adversePct}
              onChange={setAdversePct}
              hint="Share of a typical move lost to informed flow"
            />
          </div>

          <div className="space-y-1 border-t border-[var(--border)] pt-2 text-[12px]">
            <Row label="Position at full inventory" value={money(model.maxNotional)} />
            <Row label="Capital at risk" value={money(model.capital)} emphasis />
            <Row label="Volume filled / month" value={money(model.filled)} />
          </div>

          <div className="space-y-1 border-t border-[var(--border)] pt-2 text-[12px]">
            <Row label="Spread earned" value={money(model.gross)} tone="positive" />
            <Row label="Adverse selection" value={`-${money(model.adverseCost)}`} tone="negative" />
            <Row label="Venue fees" value={`-${money(model.fees)}`} tone="negative" />
            <Row
              label="Net / month"
              value={money(model.net)}
              emphasis
              tone={losing ? 'negative' : 'positive'}
            />
            <Row
              label="Return on capital / month"
              value={`${(model.monthlyReturn * 100).toFixed(1)}%`}
              tone={losing ? 'negative' : undefined}
            />
          </div>
        </div>

        {/* ── The zero-capital alternative ──────────────────────────────── */}
        <div className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
          <h3 className="text-[13px] font-semibold text-[var(--text)]">
            Fees on user flow — no capital
          </h3>

          <Input
            label="User volume / month (USD)"
            value={userVolume}
            onChange={setUserVolume}
          />

          <div className="space-y-1 border-t border-[var(--border)] pt-2 text-[12px]">
            <Row label={`Perp builder fee (${perpBuilderBps} bps)`} value={money(model.perpRevenue)} />
            <Row label={`Spot fee (${spotFeeBps} bps)`} value={money(model.spotRevenue)} />
            <Row
              label="Total / month"
              value={money(model.perpRevenue + model.spotRevenue)}
              emphasis
              tone="positive"
            />
            <Row label="Capital at risk" value="$0" emphasis />
          </div>

          {model.capitalToMatchFees !== null ? (
            <Notice tone="neutral">
              To match that from market making you would need{' '}
              <strong>{money(model.capitalToMatchFees)}</strong> of capital at risk, at the return
              modelled on the left.
            </Notice>
          ) : (
            <Notice tone="warning">
              At these assumptions the book loses money, so no amount of capital matches the fee
              revenue.
            </Notice>
          )}
        </div>
      </div>

      {losing ? (
        <Notice tone="negative" title="This configuration loses money">
          Adverse selection exceeds the spread. Widen the quote, reduce turnover, or accept that
          the market is too fast to make at this width — the flow that hits a thin quote is the
          flow that knows something.
        </Notice>
      ) : null}

      <Notice tone="warning" title="Nothing here trades">
        The quoting engine is real and tested, but nothing in this platform can place a maker
        order. A book quotes continuously, which needs a signing key live on the server — and this
        platform is built so no key exists there. That is the rule protecting user funds, and
        crossing it is a decision to make deliberately rather than inherit from a feature.
      </Notice>

      <p className="text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
        Price and volatility are live. Turnover and adverse selection are assumptions and cannot be
        measured before running a book — they are controls rather than results, because how fast
        the answer moves when you change them is the finding. Returns here are also linear in size,
        which real books are not: filling {money(model.filled)} a month at this spread assumes depth
        that does not exist at every size.
      </p>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] uppercase tracking-[0.07em] text-[var(--text-subtle)]">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1 font-[family-name:var(--font-mono)] tabular-nums text-[13px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
      />
      {hint ? <span className="block text-[9.5px] text-[var(--text-subtle)]">{hint}</span> : null}
    </label>
  );
}

function Row({
  label,
  value,
  emphasis,
  tone,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  tone?: 'positive' | 'negative';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span
        className={cn(
          'font-[family-name:var(--font-mono)] tabular-nums',
          emphasis && 'font-semibold',
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

function num(value: string): number {
  const parsed = Number(value.replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
  return `${sign}$${abs.toFixed(2)}`;
}
