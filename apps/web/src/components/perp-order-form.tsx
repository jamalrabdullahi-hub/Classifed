'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { TriangleAlert, ShieldCheck } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Notice, cn } from '@flt/ui';
import { ApiError, post } from '@/lib/api';
import { PerpSubmit } from '@/components/perp-submit';
import type { SubmittableOrder } from '@/lib/hyperliquid-agent';

/**
 * The perpetual order ticket.
 *
 * ## Size is in dollars
 *
 * Liquidity sits in USDC and USDT and traders think in dollars. Asking for
 * "0.0125 BTC" makes them divide by a moving price in their head — which is
 * exactly the arithmetic that produces an order ten times the intended size.
 * The ticket takes dollars, the server converts once at a stated price and
 * rounds **down**, and the contract count is shown before anything is signed.
 *
 * ## Leverage is typed, not dragged
 *
 * A slider makes every value between 1x and the cap equally easy to reach and
 * encodes no meaning. Typing 20 is a decision; dragging to 20 is a gesture.
 * The bound is enforced on the value, not on how far a handle can travel.
 *
 * ## The waterfall decides the cap
 *
 * Insurance first, margin second. That ordering holds only while the
 * protection boundary sits between the mark and the venue's liquidation price,
 * and above a certain leverage it is false. So the maximum leverage shown here
 * comes from live volatility, not from a constant — and it moves during the
 * day. The server refuses independently; this is the same rule stated early
 * enough to be useful.
 *
 * ## Confirmation is a separate, deliberate act
 *
 * Review, then a modal that restates size, leverage, liquidation and premium
 * and has to be dismissed on purpose. Two steps for an irreversible,
 * leveraged, signed action.
 */

interface Props {
  symbol: string;
  markPrice: string | null;
  minSize: string;
  /** FLT's cap. The waterfall may cap it further, and usually does. */
  maxLeverage: number;
  /**
   * The venue's cap, which is a different number and is the one liquidation
   * depends on. Maintenance margin is a property of the market as the venue
   * defines it and does not change because FLT chose to offer less.
   */
  venueMaxLeverage: number;
  venueName: string;
  builderMaxFeeRate: string;
  /** A price the user clicked in the order book. Only ever seeds the limit. */
  priceFromBook?: string | null;
  embedded?: boolean;
  /** The stablecoin margin is denominated in, for labelling. */
  quoteAsset?: string;
}

interface PreparedResponse {
  orderId: string;
  kind: 'OPEN';
  action:
    | {
        kind: 'venue-order';
        endpoint: string;
        requiresAgentKey: boolean;
        order: SubmittableOrder & { symbol: string };
      }
    | { kind: 'evm-transaction' | 'typed-data' };
  preview: {
    notional: string;
    marginRequired: string;
    estimatedPrice: string | null;
    integratorFee: string | null;
    reversesPosition: boolean;
  };
  liquidation: { price: string | null; source: 'venue' | 'estimated' };
  warnings: Array<{ code: string; message: string }>;
}

interface Quote {
  markPrice: string;
  position: {
    usdNotional: string;
    contracts: string;
    leverage: number;
    marginRequired: string;
    estimatedLiquidation: string | null;
  };
  cover: {
    percentile: string;
    zScore: string;
    boundary: string;
    statisticalMove: string;
    dailySigma: string;
    horizonDays: string;
  };
  premium: {
    contribution: string;
    operatorFeeBps: number;
    operatorFee: string;
    total: string;
    rateOnNotional: string;
  };
  waterfall: { holds: boolean; maxLeverage: number; refusal: string | null };
  required: boolean;
  sellable: boolean;
}

/**
 * The venue's minimum order value, in USD. Used as the floor of the size hint,
 * so the ticket never advertises a minimum the venue will refuse — its own
 * minimum *size* is a contract count worth far less than this on cheap markets.
 */
const MIN_ORDER_VALUE_USD = 10;

/** The presets, as σ-bands people recognise. */
const PRESETS = [
  { value: 0.68, label: '68%' },
  { value: 0.95, label: '95%' },
  { value: 0.997, label: '99.7%' },
];

export function PerpOrderForm({
  symbol,
  markPrice,
  minSize,
  maxLeverage,
  venueMaxLeverage,
  venueName,
  builderMaxFeeRate,
  priceFromBook = null,
  embedded = false,
  quoteAsset = 'USDC',
}: Props) {
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [usdSize, setUsdSize] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [leverageText, setLeverageText] = useState('2');
  const [percentile, setPercentile] = useState(0.95);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedResponse | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [confirming, setConfirming] = useState(false);

  const leverage = Number(leverageText);
  const leverageValid = Number.isInteger(leverage) && leverage >= 1 && leverage <= maxLeverage;
  const sizeValid = /^\d+(\.\d+)?$/.test(usdSize.trim()) && Number(usdSize) > 0;

  /**
   * The protection quote, debounced.
   *
   * It carries the waterfall bound as well as the price, so it has to be in
   * hand before the ticket can say whether this leverage is permitted at all.
   * Debounced because it costs the venue a candle request, and keyed on every
   * input that changes the answer.
   */
  const latest = useRef(0);
  useEffect(() => {
    if (!sizeValid || !leverageValid) {
      setQuote(null);
      return;
    }

    const token = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const next = await post<Quote>('/api/protection/quote', {
          symbol,
          side,
          usdNotional: usdSize.trim(),
          leverage,
          percentile,
        });
        // Out-of-order responses would show a premium for a size the user has
        // already changed, which is worse than showing nothing.
        if (token === latest.current) {
          setQuote(next);
          setError(null);
        }
      } catch (caught) {
        if (token === latest.current) {
          setQuote(null);
          if (caught instanceof ApiError) setError(caught.message);
        }
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [symbol, side, usdSize, leverage, percentile, sizeValid, leverageValid]);

  const local = useMemo(() => {
    const price = Number(limitPrice || markPrice);
    const usd = Number(usdSize);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(usd) || usd <= 0) return null;
    if (!leverageValid) return null;

    const margin = usd / leverage;
    const mmf = 1 / (2 * venueMaxLeverage);
    const sign = side === 'LONG' ? 1 : -1;
    const liquidation = (price - (sign * price) / leverage) / (1 - sign * mmf);

    return {
      contracts: usd / price,
      margin,
      liquidation: liquidation > 0 ? liquidation : null,
      movePercent: (Math.abs(price - liquidation) / price) * 100,
    };
  }, [markPrice, limitPrice, usdSize, leverage, leverageValid, side, venueMaxLeverage]);

  useEffect(() => {
    if (priceFromBook) setLimitPrice(priceFromBook);
  }, [priceFromBook]);

  const blockedByWaterfall = quote !== null && !quote.waterfall.holds;
  const canReview = sizeValid && leverageValid && !blockedByWaterfall;

  async function placeOrder() {
    setError(null);
    setPending(true);

    try {
      const result = await post<PreparedResponse>('/api/perps/orders', {
        action: 'open',
        symbol,
        side,
        // The server converts dollars to contracts itself, at its own mark, so
        // the browser's rounding is never what gets traded.
        usdNotional: usdSize.trim(),
        leverage,
        marginMode: 'ISOLATED',
        limitPrice: limitPrice || null,
        slippageBps: 50,
        reduceOnly: false,
        protectionPercentile: percentile,
      });
      setPrepared(result);
      setConfirming(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not prepare the order.');
      setConfirming(false);
    } finally {
      setPending(false);
    }
  }

  if (prepared) {
    return (
      <ReviewPanel
        prepared={prepared}
        symbol={symbol}
        side={side}
        leverage={leverage}
        venueName={venueName}
        builderMaxFeeRate={builderMaxFeeRate}
        onBack={() => setPrepared(null)}
        onSubmitted={() => setUsdSize('')}
      />
    );
  }

  const body = (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (canReview) setConfirming(true);
      }}
      className={embedded ? 'space-y-2.5 p-2.5' : 'space-y-4'}
    >
      {error ? <Notice tone="negative">{error}</Notice> : null}

      <div className="grid grid-cols-2 gap-2">
        {(['LONG', 'SHORT'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setSide(option)}
            aria-pressed={side === option}
            className={cn(
              'rounded-[var(--radius-md)] border px-3 py-2 text-[13px] font-medium transition-colors',
              side === option
                ? 'border-[var(--text)] bg-[var(--surface-raised)] text-[var(--text)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]',
            )}
          >
            {option === 'LONG' ? 'Long' : 'Short'}
          </button>
        ))}
      </div>

      <Field
        label={`Size (${quoteAsset})`}
        description={
          quote
            ? `≈ ${Number(quote.position.contracts).toFixed(6)} ${symbol}`
            : // Stated in dollars, because that is the box they are typing in.
              // "Minimum 0.00001 BTC" makes the reader do the conversion the
              // dollar-denominated ticket exists to remove.
              markPrice
              ? `Minimum ${money(Math.max(Number(minSize) * Number(markPrice), MIN_ORDER_VALUE_USD))}`
              : `Minimum ${minSize} ${symbol}`
        }
      >
        {(props) => (
          <Input
            {...props}
            value={usdSize}
            onChange={(event) => setUsdSize(event.target.value)}
            inputMode="decimal"
            placeholder="1000"
            className="num"
            required
          />
        )}
      </Field>

      <Field
        label="Limit price"
        description={limitPrice ? undefined : 'Leave empty for a market order'}
      >
        {(props) => (
          <Input
            {...props}
            value={limitPrice}
            onChange={(event) => setLimitPrice(event.target.value)}
            inputMode="decimal"
            placeholder={markPrice ?? 'Market'}
            className="num"
          />
        )}
      </Field>

      <Field
        label="Leverage"
        description={
          quote
            ? `Up to ${Math.min(quote.waterfall.maxLeverage, maxLeverage)}x with this cover`
            : `1x to ${maxLeverage}x`
        }
        error={
          leverageText !== '' && !leverageValid
            ? `Enter a whole number between 1 and ${maxLeverage}`
            : undefined
        }
      >
        {(props) => (
          <Input
            {...props}
            value={leverageText}
            onChange={(event) => setLeverageText(event.target.value.replace(/[^\d]/g, ''))}
            inputMode="numeric"
            placeholder="2"
            className="num"
            required
          />
        )}
      </Field>

      <div className="space-y-1.5">
        <span className="text-[13px] text-[var(--text-muted)]">Cover level</span>
        <div className="grid grid-cols-3 gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => setPercentile(preset.value)}
              aria-pressed={percentile === preset.value}
              className={cn(
                'rounded-[var(--radius-md)] border px-2 py-1.5 text-[12px] transition-colors',
                percentile === preset.value
                  ? 'border-[var(--text)] bg-[var(--surface-raised)] text-[var(--text)]'
                  : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]',
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {blockedByWaterfall ? (
        <Notice tone="negative" icon={<TriangleAlert className="size-4" />} title="Leverage too high for this cover">
          {quote?.waterfall.refusal}
        </Notice>
      ) : null}

      {local ? (
        <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] p-3 text-[13px]">
          <Row label="Margin required" value={money(local.margin)} />
          <Row
            label="Liquidation price (est.)"
            value={local.liquidation ? money(local.liquidation) : 'n/a'}
            emphasis
          />
          {quote ? (
            <>
              <Row
                label={`Protection boundary (${(percentile * 100).toFixed(percentile === 0.997 ? 1 : 0)}%)`}
                value={money(Number(quote.cover.boundary))}
              />
              <div className="border-t border-[var(--border)] pt-2">
                <Row label="Contribution to pool" value={money(Number(quote.premium.contribution))} />
                <Row
                  label={`FLT fee (${quote.premium.operatorFeeBps / 100}%)`}
                  value={money(Number(quote.premium.operatorFee))}
                />
                <Row
                  label="Premium total"
                  value={money(Number(quote.premium.total))}
                  emphasis
                />
              </div>
            </>
          ) : null}
          {local.liquidation ? (
            <p
              className={cn(
                'pt-1 text-[12px]',
                local.movePercent < 10 ? 'text-[var(--negative)]' : 'text-[var(--text-muted)]',
              )}
            >
              A {local.movePercent.toFixed(1)}% move against you closes this position.
            </p>
          ) : null}
        </div>
      ) : null}

      <Button type="submit" variant="primary" block disabled={!canReview}>
        Review order
      </Button>

      <p className="text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
        {quote?.required
          ? 'Leverage requires protection. The premium is paid from your wallet — the contribution to the protection pool, the fee to FLT — and both are separate from the margin the venue holds.'
          : 'Estimates only, before fees and funding.'}{' '}
        {venueName} reports the real liquidation price once the position exists, and it moves as
        funding accrues.
      </p>
    </form>
  );

  return (
    <>
      {confirming && quote ? (
        <ConfirmDialog
          symbol={symbol}
          side={side}
          quote={quote}
          quoteAsset={quoteAsset}
          isMarket={!limitPrice}
          pending={pending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void placeOrder()}
        />
      ) : null}

      {embedded ? (
        body
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Open a position</CardTitle>
          </CardHeader>
          <CardContent>{body}</CardContent>
        </Card>
      )}
    </>
  );
}

/**
 * The fat-finger guard.
 *
 * Restates the trade in the terms that go wrong: the dollar size, what that is
 * in contracts, the leverage, and how far the price has to move to end the
 * position. Deliberately modal and deliberately not dismissible by clicking
 * away — this is the last point at which a mistyped size is free to correct.
 */
function ConfirmDialog({
  symbol,
  side,
  quote,
  quoteAsset,
  isMarket,
  pending,
  onCancel,
  onConfirm,
}: {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quote: Quote;
  quoteAsset: string;
  isMarket: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const liquidation = quote.position.estimatedLiquidation;
  const move = liquidation
    ? (Math.abs(Number(quote.markPrice) - Number(liquidation)) / Number(quote.markPrice)) * 100
    : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm order"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div className="w-full max-w-sm space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--canvas)] p-4">
        <h2 className="text-[15px] font-semibold text-[var(--text)]">
          {side === 'LONG' ? 'Long' : 'Short'} {symbol} at {quote.position.leverage}x
        </h2>

        <div className="space-y-1.5 text-[13px]">
          <Row label="Size" value={`${money(Number(quote.position.usdNotional))} ${quoteAsset}`} emphasis />
          <Row label="Contracts" value={`${Number(quote.position.contracts).toFixed(6)} ${symbol}`} />
          <Row label="Order type" value={isMarket ? 'Market' : 'Limit'} />
          <Row label="Margin" value={money(Number(quote.position.marginRequired))} />
          <Row
            label="Liquidation (est.)"
            value={liquidation ? money(Number(liquidation)) : 'n/a'}
            emphasis
          />
          <Row label="Premium" value={money(Number(quote.premium.total))} emphasis />
        </div>

        {move !== null ? (
          <Notice tone={move < 10 ? 'negative' : 'warning'} icon={<TriangleAlert className="size-4" />}>
            A {move.toFixed(1)}% move against you ends this position. You are risking{' '}
            {money(Number(quote.position.marginRequired))} of margin plus{' '}
            {money(Number(quote.premium.total))} of premium.
          </Notice>
        ) : null}

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--text-subtle)]">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          Protection resolves before the venue&apos;s margin call: the boundary at{' '}
          {money(Number(quote.cover.boundary))} is reached first. Of the premium,{' '}
          {money(Number(quote.premium.contribution))} goes to the protection pool and{' '}
          {money(Number(quote.premium.operatorFee))} to FLT.
        </p>

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

function ReviewPanel({
  prepared,
  symbol,
  side,
  leverage,
  venueName,
  builderMaxFeeRate,
  onBack,
  onSubmitted,
}: {
  prepared: PreparedResponse;
  symbol: string;
  side: 'LONG' | 'SHORT';
  leverage: number;
  venueName: string;
  builderMaxFeeRate: string;
  onBack: () => void;
  onSubmitted: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Review</CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2 text-[13px]">
          <Row label="Market" value={`${symbol} perpetual`} />
          <Row label="Direction" value={side === 'LONG' ? 'Long' : 'Short'} />
          <Row label="Leverage" value={`${leverage}x`} />
          <Row label="Position value" value={money(Number(prepared.preview.notional))} />
          <Row
            label="Margin required"
            value={money(Number(prepared.preview.marginRequired))}
          />
          <Row
            label={
              prepared.liquidation.source === 'venue'
                ? 'Liquidation price'
                : 'Liquidation price (est.)'
            }
            value={
              prepared.liquidation.price
                ? money(Number(prepared.liquidation.price))
                : 'n/a'
            }
            emphasis
          />
          {prepared.preview.integratorFee ? (
            <Row label="FLT fee" value={`$${Number(prepared.preview.integratorFee).toFixed(4)}`} />
          ) : null}
        </div>

        {prepared.warnings.map((warning) => (
          <Notice
            key={warning.code}
            tone={warning.code === 'reverses_position' ? 'negative' : 'warning'}
            icon={<TriangleAlert className="size-4" />}
          >
            {warning.message}
          </Notice>
        ))}

        <PerpSubmit
          symbol={symbol}
          side={side}
          usdNotional={prepared.preview.notional}
          leverage={leverage}
          venueName={venueName}
          builderMaxFeeRate={builderMaxFeeRate}
          onDone={onSubmitted}
        />

        <Button variant="secondary" block onClick={onBack}>
          Back
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * One place for dollar formatting.
 *
 * Thousands separators throughout: "$1000.00" and "$70798.35" are read wrong
 * at a glance, and a confirmation dialog exists precisely to be read at a
 * glance.
 */
function money(amount: number): string {
  if (!Number.isFinite(amount)) return 'n/a';
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span
        className={cn('num', emphasis ? 'font-semibold text-[var(--text)]' : 'text-[var(--text)]')}
      >
        {value}
      </span>
    </div>
  );
}
