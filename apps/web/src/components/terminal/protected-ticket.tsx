'use client';

import { useEffect, useMemo, useState } from 'react';
import { TriangleAlert, ShieldCheck } from 'lucide-react';
import { Button, Notice, cn } from '@flt/ui';
import { ApiError, get, post } from '@/lib/api';
import {
  COVERAGE_PRESETS,
  HORIZON_PRESETS,
  formatHorizon,
  horizonForPolicy,
  horizonToDays,
  priceProtection,
  type HorizonSelection,
  type PolicyKind,
  type Pricing,
} from '@/lib/protection-math';
import type { Candle } from '@flt/core/ports/history';

/**
 * The execution ticket, with cover priced as you type.
 *
 * ## Priced in this browser
 *
 * The premium is computed here, from the candles the chart already loaded and
 * the mark on the ticker, using the same functions the server runs. No round
 * trip per keystroke, no venue candle request per keystroke, and the numbers
 * move with the controls rather than lagging half a second behind them.
 *
 * The server prices it again at execution and its answer is the binding one.
 * This is an exact preview, not a substitute for that.
 *
 * ## Coverage is in standard deviations
 *
 * "95%" invites the reader to assume the two-tailed 1.96σ when the boundary is
 * one-sided. Choosing σ directly removes the ambiguity — the boundary sits z
 * deviations away over the window you picked — and the confidence that follows
 * is shown rather than assumed.
 *
 * ## Any horizon, not just the presets
 *
 * The deviation scales with √T, so two days and eight days are as well defined
 * as one day. Presets are shortcuts, not the menu.
 */

interface Props {
  symbol: string;
  markPrice: string | null;
  maxLeverage: number;
  venueMaxLeverage: number;
  minSize: string;
  quoteAsset?: string;
  operatorFeeBps?: number;
  protectionRequired?: boolean;
}

const POLICY_LABELS: Record<PolicyKind, string> = {
  BASE_DAY: 'Based',
  BASE_SMOOTH: 'Smooth based',
  OMNI: 'Omni basing',
};

const POLICY_NOTES: Record<PolicyKind, string> = {
  BASE_DAY: 'Calculated once at entry. Fixed for one day, never rebased.',
  BASE_SMOOTH: 'Anchored to entry, scaling its response as the position deteriorates.',
  OMNI: 'Re-anchors to the current price each time it rebases.',
};

export function ProtectedTicket({
  symbol,
  markPrice,
  maxLeverage,
  venueMaxLeverage,
  quoteAsset = 'USDC',
  operatorFeeBps = 1_000,
  protectionRequired = true,
}: Props) {
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [amount, setAmount] = useState('');
  const [leverageText, setLeverageText] = useState('2');
  const [insured, setInsured] = useState(true);
  const [policy, setPolicy] = useState<PolicyKind>('BASE_DAY');
  const [horizon, setHorizon] = useState<HorizonSelection>({ amount: 1, unit: 'days' });
  const [z, setZ] = useState(2);

  const [candles, setCandles] = useState<Candle[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const leverage = Number(leverageText);
  const leverageValid = Number.isInteger(leverage) && leverage >= 1 && leverage <= maxLeverage;

  // Loaded once. The pricing needs a volatility estimate, not a live tick, and
  // a fresh candle every few seconds would move the premium under the reader.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await get<{ candles: Candle[] }>(
          `/api/perps/markets/${symbol}/candles?interval=1h&limit=400`,
        );
        if (!cancelled) setCandles(data.candles);
      } catch {
        if (!cancelled) setCandles([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const effectiveHorizon = horizonForPolicy(policy, horizon);
  const horizonDays = horizonToDays(effectiveHorizon);

  const pricing: Pricing | null = useMemo(() => {
    if (!markPrice || !leverageValid) return null;
    return priceProtection({
      candles,
      interval: '1h',
      markPrice,
      usdNotional: amount,
      leverage,
      z,
      horizonDays,
      side,
      venueMaxLeverage,
      operatorFeeBps,
    });
  }, [
    candles,
    markPrice,
    amount,
    leverage,
    leverageValid,
    z,
    horizonDays,
    side,
    venueMaxLeverage,
    operatorFeeBps,
  ]);

  const blocked = insured && pricing !== null && !pricing.waterfallHolds;
  const ready = Boolean(amount) && leverageValid && (!insured || pricing !== null) && !blocked;

  async function execute() {
    setError(null);
    setPending(true);
    try {
      await post('/api/perps/orders', {
        action: 'open',
        symbol,
        side,
        usdNotional: amount.trim(),
        leverage,
        marginMode: 'ISOLATED',
        slippageBps: 50,
        reduceOnly: false,
        ...(insured
          ? {
              protectionPercentile: pricing!.confidence,
              protectionKind: policy,
              protectionHorizonDays: horizonDays,
            }
          : {}),
      });
      setDone('Order prepared. Sign it in your wallet to send it to the venue.');
      setConfirming(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not prepare the order.');
      setConfirming(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2.5 p-2.5 text-[11px]">
      {error ? <Notice tone="negative">{error}</Notice> : null}
      {done ? <Notice tone="positive">{done}</Notice> : null}

      <div className="grid grid-cols-2 gap-1.5">
        {(['LONG', 'SHORT'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setSide(option)}
            aria-pressed={side === option}
            className={cn(
              'rounded-[var(--radius-md)] border px-3 py-1.5 text-[12px] font-medium transition-colors',
              side === option
                ? 'border-[var(--text)] bg-[var(--surface-raised)] text-[var(--text)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]',
            )}
          >
            {option === 'LONG' ? 'Buy / Long' : 'Sell / Short'}
          </button>
        ))}
      </div>

      <LabeledInput
        label={`Amount (${quoteAsset})`}
        value={amount}
        onChange={setAmount}
        placeholder="1000"
        hint={pricing ? `≈ ${pricing.marginRequired.times(leverage).dividedBy(markPrice ?? 1).toFixed(6)} ${symbol}` : undefined}
      />

      <LabeledInput
        label="Leverage"
        value={leverageText}
        onChange={(next) => setLeverageText(next.replace(/[^\d]/g, ''))}
        placeholder="2"
        hint={
          pricing && insured
            ? `up to ${Math.min(pricing.maxLeverage, maxLeverage)}x with this cover`
            : `1x to ${maxLeverage}x`
        }
      />

      {/* ── Coverage ─────────────────────────────────────────────────────── */}
      <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] p-2">
        <label className="flex items-center justify-between gap-2">
          <span className="font-medium text-[var(--text)]">Coverage</span>
          <input
            type="checkbox"
            checked={insured}
            disabled={protectionRequired && leverage > 1}
            onChange={(event) => setInsured(event.target.checked)}
            className="size-3.5 accent-[var(--text)]"
          />
        </label>

        {protectionRequired && leverage > 1 ? (
          <p className="text-[10px] text-[var(--text-subtle)]">
            Required on leveraged positions.
          </p>
        ) : null}

        {insured ? (
          <>
            <Segmented
              label="Policy"
              options={(['BASE_DAY', 'BASE_SMOOTH', 'OMNI'] as const).map((kind) => ({
                value: kind,
                label: POLICY_LABELS[kind],
              }))}
              value={policy}
              onChange={(next) => setPolicy(next as PolicyKind)}
            />
            <p className="text-[10px] leading-relaxed text-[var(--text-subtle)]">
              {POLICY_NOTES[policy]}
            </p>

            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                Time frame
              </span>
              {policy === 'BASE_DAY' ? (
                <p className="text-[10.5px] text-[var(--text-muted)]">
                  Fixed at 1 day — Based is a single-day policy.
                </p>
              ) : (
                <>
                  <div className="flex gap-1.5">
                    <input
                      value={String(horizon.amount)}
                      onChange={(event) =>
                        setHorizon({
                          ...horizon,
                          amount: Number(event.target.value.replace(/[^\d]/g, '')) || 0,
                        })
                      }
                      inputMode="numeric"
                      aria-label="Time frame amount"
                      className="w-14 rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-1.5 py-1 text-center font-[family-name:var(--font-mono)] tabular-nums text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
                    />
                    <div className="flex flex-1 gap-1">
                      {(['hours', 'days', 'weeks'] as const).map((unit) => (
                        <button
                          key={unit}
                          type="button"
                          onClick={() => setHorizon({ ...horizon, unit })}
                          aria-pressed={horizon.unit === unit}
                          className={cn(
                            'flex-1 rounded-[var(--radius)] border px-1 py-1 text-[10px] transition-colors',
                            horizon.unit === unit
                              ? 'border-[var(--text)] text-[var(--text)]'
                              : 'border-[var(--border)] text-[var(--text-muted)]',
                          )}
                        >
                          {unit}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {HORIZON_PRESETS.map((preset) => (
                      <button
                        key={formatHorizon(preset)}
                        type="button"
                        onClick={() => setHorizon(preset)}
                        className="rounded-[var(--radius)] border border-[var(--border)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-subtle)] hover:text-[var(--text)]"
                      >
                        {formatHorizon(preset)}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="space-y-1">
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                  Cover
                </span>
                {pricing ? (
                  <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-subtle)]">
                    {(pricing.confidence * 100).toFixed(2)}% one-tailed
                  </span>
                ) : null}
              </div>
              <div className="flex gap-1.5">
                {COVERAGE_PRESETS.map((preset) => (
                  <button
                    key={preset.z}
                    type="button"
                    onClick={() => setZ(preset.z)}
                    aria-pressed={z === preset.z}
                    className={cn(
                      'flex-1 rounded-[var(--radius)] border px-2 py-1 text-[11px] transition-colors',
                      z === preset.z
                        ? 'border-[var(--text)] bg-[var(--surface-raised)] text-[var(--text)]'
                        : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]',
                    )}
                  >
                    {preset.label}
                  </button>
                ))}
                <input
                  value={String(z)}
                  onChange={(event) => setZ(Number(event.target.value) || 0)}
                  inputMode="decimal"
                  aria-label="Standard deviations"
                  className="w-14 rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-1.5 py-1 text-center font-[family-name:var(--font-mono)] tabular-nums text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
                />
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* ── The calculator ───────────────────────────────────────────────── */}
      {pricing ? (
        <div className="space-y-1 rounded-[var(--radius-md)] border border-[var(--border)] p-2">
          <Row label={`${symbol} ${side === 'LONG' ? 'long' : 'short'}`} value={`${leverage}x`} />
          {insured ? (
            <>
              <Row
                label="Deviation over window"
                value={`${pricing.horizonSigma.times(100).toFixed(2)}%`}
              />
              <Row
                label={`Covered move (${z}σ)`}
                value={`${pricing.coveredMagnitude.times(100).toFixed(2)}%`}
              />
              <Row label="Boundary" value={money(pricing.boundary)} />
              <Row
                label="Chance of peril"
                value={`${pricing.perilProbability.times(100).toFixed(2)}%`}
              />
              <Row label="Pays you if hit" value={money(pricing.indemnity)} emphasis />
            </>
          ) : null}
          <div className="border-t border-[var(--border)] pt-1">
            <Row label="Margin" value={money(pricing.marginRequired)} />
            {insured ? (
              <>
                <Row label="Policy" value={money(pricing.contribution)} />
                <Row label={`Fee (${operatorFeeBps / 100}%)`} value={money(pricing.operatorFee)} />
              </>
            ) : null}
            <Row label="Total" value={money(pricing.totalToPay)} emphasis />
          </div>
          {pricing.estimatedLiquidation ? (
            <Row
              label="Liquidation (est.)"
              value={money(pricing.estimatedLiquidation)}
            />
          ) : null}
        </div>
      ) : null}

      {blocked ? (
        <Notice tone="negative" icon={<TriangleAlert className="size-4" />}>
          At {leverage}x the venue liquidates before cover reaches its boundary, so insurance
          would never resolve first. {pricing?.maxLeverage}x is the most this cover supports.
        </Notice>
      ) : null}

      <Button variant="primary" block disabled={!ready} onClick={() => setConfirming(true)}>
        Execute
      </Button>

      {confirming && pricing ? (
        <ConfirmDialog
          symbol={symbol}
          side={side}
          leverage={leverage}
          insured={insured}
          policy={policy}
          horizon={effectiveHorizon}
          z={z}
          pricing={pricing}
          quoteAsset={quoteAsset}
          pending={pending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void execute()}
        />
      ) : null}
    </div>
  );
}

function ConfirmDialog({
  symbol,
  side,
  leverage,
  insured,
  policy,
  horizon,
  z,
  pricing,
  quoteAsset,
  pending,
  onCancel,
  onConfirm,
}: {
  symbol: string;
  side: 'LONG' | 'SHORT';
  leverage: number;
  insured: boolean;
  policy: PolicyKind;
  horizon: HorizonSelection;
  z: number;
  pricing: Pricing;
  quoteAsset: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm order"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div className="w-full max-w-sm space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--canvas)] p-4 text-[12px]">
        <h2 className="text-[15px] font-semibold text-[var(--text)]">
          {side === 'LONG' ? 'Long' : 'Short'} {symbol} at {leverage}x
        </h2>

        <div className="space-y-1.5">
          <Row
            label="Amount"
            value={`${money(pricing.marginRequired.times(leverage))} ${quoteAsset}`}
            emphasis
          />
          <Row label="Margin" value={money(pricing.marginRequired)} />
          {insured ? (
            <>
              <Row label="Policy" value={POLICY_LABELS[policy]} />
              <Row label="Time frame" value={formatHorizon(horizon)} />
              <Row label="Cover" value={`${z}σ — ${(pricing.confidence * 100).toFixed(2)}%`} />
              <Row label="Boundary" value={money(pricing.boundary)} />
              <Row label="Premium" value={money(pricing.contribution)} />
              <Row label="Fee" value={money(pricing.operatorFee)} />
            </>
          ) : null}
          <div className="border-t border-[var(--border)] pt-1.5">
            <Row label="Total amount" value={money(pricing.totalToPay)} emphasis />
          </div>
        </div>

        {insured ? (
          <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            A {pricing.coveredMagnitude.times(100).toFixed(2)}% move against you within{' '}
            {formatHorizon(horizon)} pays {money(pricing.indemnity)}. Cover resolves before the
            venue&apos;s margin call.
          </p>
        ) : (
          <Notice tone="warning" icon={<TriangleAlert className="size-4" />}>
            No cover. A move against you is yours alone.
          </Notice>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={pending}>
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
        className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 font-[family-name:var(--font-mono)] tabular-nums text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
      />
      {hint ? <span className="block text-[10px] text-[var(--text-subtle)]">{hint}</span> : null}
    </label>
  );
}

function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
        {label}
      </span>
      <div className="flex gap-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={cn(
              'flex-1 rounded-[var(--radius)] border px-1 py-1 text-[10px] transition-colors',
              value === option.value
                ? 'border-[var(--text)] bg-[var(--surface-raised)] text-[var(--text)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span
        className={cn(
          'font-[family-name:var(--font-mono)] tabular-nums',
          emphasis ? 'font-semibold text-[var(--text)]' : 'text-[var(--text)]',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function money(amount: { toNumber: () => number }): string {
  const value = amount.toNumber();
  if (!Number.isFinite(value)) return '—';
  const decimals = Math.abs(value) >= 1 ? 2 : 6;
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}
