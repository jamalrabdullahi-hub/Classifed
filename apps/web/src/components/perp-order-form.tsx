'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Notice, cn } from '@flt/ui';
import { ApiError, post } from '@/lib/api';
import { PerpSubmit } from '@/components/perp-submit';
import type { SubmittableOrder } from '@/lib/hyperliquid-agent';

/**
 * The perpetual order ticket.
 *
 * Two decisions shape this component.
 *
 * **The liquidation price is computed as you type, not on review.** On the spot
 * path it is reasonable to type an amount and then see the consequences on a
 * review screen, because the worst case is a bad price. Here the worst case is
 * the position being closed and the margin gone, so the number that describes
 * that has to move while the leverage slider does — otherwise leverage feels
 * free until the moment it is committed.
 *
 * **Leverage is a slider with the consequence attached.** Presenting 1x to 40x
 * as equivalent options separated only by a number invites the top of the
 * range. Showing the distance to liquidation shrinking as the slider moves is
 * the same information, stated in the terms that actually matter.
 *
 * The estimate shown here is deliberately labelled as one. The venue's own
 * liquidation price accounts for fees and accrued funding and is authoritative
 * once a position exists; this is a preview of a position that does not.
 */

interface Props {
  symbol: string;
  markPrice: string | null;
  minSize: string;
  /** FLT's cap. Bounds the slider — this is what a user may actually choose. */
  maxLeverage: number;
  /**
   * The venue's cap, which is a different number and is the one liquidation
   * depends on.
   *
   * Maintenance margin is a property of the market as the venue defines it —
   * half the initial requirement at *its* maximum leverage — and it does not
   * change because FLT chose to offer less. Using FLT's cap here computes a
   * liquidation price the venue will never agree with, and the ticket would
   * disagree with the review screen for the same order.
   */
  venueMaxLeverage: number;
  venueName: string;
  /** The maximum fee the user approves, as a percentage string, e.g. "0.1%". */
  builderMaxFeeRate: string;
  /**
   * A price the user clicked in the order book.
   *
   * Only ever seeds the limit price; it never changes size, side or leverage.
   * A click in a ladder means "this price", not "this order".
   */
  priceFromBook?: string | null;
  /** Renders without card chrome, for use inside a terminal panel. */
  embedded?: boolean;
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
}: Props) {
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [size, setSize] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [leverage, setLeverage] = useState(Math.min(2, maxLeverage));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedResponse | null>(null);

  /**
   * Local preview, mirroring the server's arithmetic.
   *
   * Duplicating the formula in the browser is a real cost, accepted because the
   * alternative is a round trip on every keystroke of the leverage slider — and
   * a liquidation price that lags the control it depends on is worse than
   * useless. The server's answer is authoritative and replaces this the moment
   * the order is prepared.
   */
  const local = useMemo(() => {
    // A limit order is judged against its own price, not the mark. Previewing a
    // limit against the mark would show a margin and liquidation price for a
    // trade the user is not placing.
    const price = Number(limitPrice || markPrice);
    const quantity = Number(size);
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) return null;

    const notional = price * quantity;
    const margin = notional / leverage;
    // Matches maintenanceMarginFraction in core: half the initial requirement
    // at the *venue's* maximum leverage for this market, not FLT's cap.
    const mmf = 1 / (2 * venueMaxLeverage);
    const sign = side === 'LONG' ? 1 : -1;
    const liquidation = (price - (sign * price) / leverage) / (1 - sign * mmf);

    return {
      notional,
      margin,
      liquidation: liquidation > 0 ? liquidation : null,
      movePercent: (Math.abs(price - liquidation) / price) * 100,
    };
  }, [markPrice, limitPrice, size, leverage, side, venueMaxLeverage]);

  useEffect(() => {
    if (priceFromBook) setLimitPrice(priceFromBook);
  }, [priceFromBook]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const result = await post<PreparedResponse>('/api/perps/orders', {
        action: 'open',
        symbol,
        side,
        size,
        leverage,
        marginMode: 'ISOLATED',
        limitPrice: limitPrice || null,
        slippageBps: 50,
        reduceOnly: false,
      });
      setPrepared(result);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not prepare the order.');
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
        onSubmitted={() => setSize('')}
      />
    );
  }

  const body = (
    <form onSubmit={onSubmit} className={embedded ? 'space-y-2.5 p-2.5' : 'space-y-4'}>
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

          <Field label={`Size (${symbol})`} description={`Minimum ${minSize}`}>
            {(props) => (
              <Input
                {...props}
                value={size}
                onChange={(event) => setSize(event.target.value)}
                inputMode="decimal"
                placeholder={minSize}
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

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <label htmlFor="leverage" className="text-[13px] text-[var(--text-muted)]">
                Leverage
              </label>
              <span className="num text-[15px] font-semibold text-[var(--text)]">{leverage}x</span>
            </div>
            <input
              id="leverage"
              type="range"
              min={1}
              max={maxLeverage}
              step={1}
              value={leverage}
              onChange={(event) => setLeverage(Number(event.target.value))}
              className="w-full accent-[var(--text)]"
            />
            <div className="flex justify-between text-[11px] text-[var(--text-subtle)]">
              <span>1x</span>
              <span>{maxLeverage}x</span>
            </div>
          </div>

          {local ? (
            <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] p-3 text-[13px]">
              <Row label="Position value" value={`$${local.notional.toFixed(2)}`} />
              <Row label="Margin required" value={`$${local.margin.toFixed(2)}`} />
              <Row
                label="Liquidation price (est.)"
                value={local.liquidation ? `$${local.liquidation.toFixed(2)}` : 'n/a'}
                emphasis
              />
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

          <Button type="submit" variant="primary" block loading={pending} disabled={!size}>
            Review order
          </Button>

      <p className="text-[10.5px] leading-relaxed text-[var(--text-subtle)]">
        Estimates only, before fees and funding. {venueName} reports the real liquidation price
        once the position exists, and it moves as funding accrues.
      </p>
    </form>
  );

  if (embedded) return body;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Open a position</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
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
          <Row label="Position value" value={`$${Number(prepared.preview.notional).toFixed(2)}`} />
          <Row
            label="Margin required"
            value={`$${Number(prepared.preview.marginRequired).toFixed(2)}`}
          />
          <Row
            label={
              prepared.liquidation.source === 'venue'
                ? 'Liquidation price'
                : 'Liquidation price (est.)'
            }
            value={
              prepared.liquidation.price
                ? `$${Number(prepared.liquidation.price).toFixed(2)}`
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

        {prepared.action.kind === 'venue-order' ? (
          <PerpSubmit
            orderId={prepared.orderId}
            order={prepared.action.order}
            venueName={venueName}
            builderMaxFeeRate={builderMaxFeeRate}
            onDone={onSubmitted}
          />
        ) : (
          <Notice tone="warning" title="This venue needs a different signing step">
            The order was prepared but this build cannot submit it to {venueName}. Nothing has been
            sent and no margin has moved.
          </Notice>
        )}

        <Button variant="secondary" block onClick={onBack}>
          Back
        </Button>
      </CardContent>
    </Card>
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
