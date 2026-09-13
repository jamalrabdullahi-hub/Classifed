'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Input, Notice, cn } from '@flt/ui';
import { ApiError, post } from '@/lib/api';
import type { PriceLineSpec } from '@/components/price-chart';

/**
 * Take-profit and stop-loss on a position that is already open.
 *
 * ## Why this exists separately from the ticket's bracket
 *
 * A bracket sent with an entry is the better instrument: the position is never
 * unprotected. But the common case is a position somebody already holds, who
 * has since decided where they want out — and until now the only exit was a
 * market close they had to be awake for.
 *
 * ## The numbers are the feature
 *
 * A price on its own does not tell anybody what it costs them. "Stop at 74,000"
 * is an abstraction; "you lose $40.60, a fifth of your margin" is the decision.
 * So every level states the money and the share of margin it represents, and it
 * updates as the price is typed rather than after the order is placed.
 *
 * Both figures are estimates and are labelled as such: a stop is a *trigger*,
 * not a fill. It becomes a market order when touched, so the realised number
 * depends on what the book does next — which is exactly what a participant
 * needs to know before relying on it.
 */

export interface BracketPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  /** Contracts. */
  size: string;
  entryPrice: string;
  markPrice: string | null;
  margin: string;
  takeProfitPrice?: string | null;
  stopLossPrice?: string | null;
}

/** Profit or loss, in quote currency, if the position closed at `price`. */
function pnlAt(position: BracketPosition, price: number): number {
  const size = Number(position.size);
  const entry = Number(position.entryPrice);
  if (!Number.isFinite(size) || !Number.isFinite(entry) || !Number.isFinite(price)) return NaN;
  // A long gains as the price rises; a short gains as it falls.
  return position.side === 'LONG' ? size * (price - entry) : size * (entry - price);
}

function money(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const magnitude = Math.abs(value);
  return `${sign}$${magnitude.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function PositionBracket({
  position,
  onLinesChange,
  onSaved,
}: {
  position: BracketPosition;
  /** Lifted so the chart can draw these levels; see perp-terminal. */
  onLinesChange?: (lines: PriceLineSpec[]) => void;
  onSaved?: () => void;
}) {
  const t = useTranslations('positionBracket');

  const [takeProfit, setTakeProfit] = useState(position.takeProfitPrice ?? '');
  const [stopLoss, setStopLoss] = useState(position.stopLossPrice ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const mark = Number(position.markPrice ?? position.entryPrice);
  const margin = Number(position.margin);
  const isLong = position.side === 'LONG';

  const tpNumber = takeProfit.trim() ? Number(takeProfit) : null;
  const slNumber = stopLoss.trim() ? Number(stopLoss) : null;

  /**
   * Wrong-side prices are caught here as well as on the server.
   *
   * The server refuses them because it must — a stop on the wrong side of the
   * mark fills the instant it is placed. This is the same rule stated while
   * there is still a field to correct, rather than as a rejection after the
   * fact.
   */
  const tpWrongSide =
    tpNumber !== null && Number.isFinite(mark) && (isLong ? tpNumber <= mark : tpNumber >= mark);
  const slWrongSide =
    slNumber !== null && Number.isFinite(mark) && (isLong ? slNumber >= mark : slNumber <= mark);
  const crossed =
    tpNumber !== null && slNumber !== null && (isLong ? slNumber >= tpNumber : slNumber <= tpNumber);

  const tpPnl = tpNumber !== null ? pnlAt(position, tpNumber) : null;
  const slPnl = slNumber !== null ? pnlAt(position, slNumber) : null;

  const share = (value: number | null) =>
    value === null || !Number.isFinite(margin) || margin <= 0
      ? null
      : `${((value / margin) * 100).toFixed(0)}%`;

  const valid =
    (tpNumber !== null || slNumber !== null) && !tpWrongSide && !slWrongSide && !crossed;

  // Draw whatever is currently typed, so the levels move on the chart as the
  // participant reasons about them — not only once they are committed.
  const lines = useMemo<PriceLineSpec[]>(() => {
    const out: PriceLineSpec[] = [];
    if (Number.isFinite(Number(position.entryPrice))) {
      out.push({
        id: `entry:${position.symbol}`,
        price: Number(position.entryPrice),
        tone: 'neutral',
        title: t('entryLine'),
        dashed: true,
      });
    }
    if (tpNumber !== null && Number.isFinite(tpNumber) && !tpWrongSide) {
      out.push({
        id: `tp:${position.symbol}`,
        price: tpNumber,
        tone: 'positive',
        title: t('takeProfitLine', { amount: money(tpPnl ?? 0) }),
      });
    }
    if (slNumber !== null && Number.isFinite(slNumber) && !slWrongSide) {
      out.push({
        id: `sl:${position.symbol}`,
        price: slNumber,
        tone: 'negative',
        title: t('stopLossLine', { amount: money(slPnl ?? 0) }),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position.symbol, position.entryPrice, tpNumber, slNumber, tpWrongSide, slWrongSide, tpPnl, slPnl]);

  useEffect(() => {
    onLinesChange?.(lines);
    // Clearing on unmount stops a closed position's levels hanging on the chart.
    return () => onLinesChange?.([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await post('/api/perps/positions/bracket', {
        symbol: position.symbol,
        takeProfitPrice: takeProfit.trim() || null,
        stopLossPrice: stopLoss.trim() || null,
        slippageBps: 100,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 4_000);
      onSaved?.();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('couldNotSave'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2.5 rounded-[var(--radius-md)] border border-[var(--border)] p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-[var(--text)]">{t('title')}</span>
        <span className="num text-[10px] text-[var(--text-subtle)]">
          {t('sizeAtEntry', { size: position.size, entry: position.entryPrice })}
        </span>
      </div>

      {error ? <Notice tone="negative">{error}</Notice> : null}

      {/* ── Take profit ─────────────────────────────────────────────────── */}
      <div className="space-y-1">
        <label className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.07em] text-[var(--text-subtle)]">
          {t('takeProfit')}
          <span className="normal-case tracking-normal">
            {t('aboveOrBelow', { side: isLong ? t('above') : t('below') })}
          </span>
        </label>
        <Input
          value={takeProfit}
          onChange={(event) => setTakeProfit(event.target.value.replace(/[^\d.]/g, ''))}
          inputMode="decimal"
          placeholder={position.markPrice ?? ''}
          className="num"
        />
        {tpWrongSide ? (
          <p className="text-[10.5px] text-[var(--negative)]">
            {t('wrongSideTp', { side: isLong ? t('above') : t('below'), mark: String(mark) })}
          </p>
        ) : tpPnl !== null ? (
          <p className="text-[10.5px] text-[var(--text-subtle)]">
            {t('youWouldMake')}{' '}
            <span className="num font-semibold text-[var(--positive)]">{money(tpPnl)}</span>
            {share(tpPnl) ? (
              <span className="num"> · {t('ofMargin', { pct: share(tpPnl)! })}</span>
            ) : null}
          </p>
        ) : null}
      </div>

      {/* ── Stop loss ───────────────────────────────────────────────────── */}
      <div className="space-y-1">
        <label className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.07em] text-[var(--text-subtle)]">
          {t('stopLoss')}
          <span className="normal-case tracking-normal">
            {t('aboveOrBelow', { side: isLong ? t('below') : t('above') })}
          </span>
        </label>
        <Input
          value={stopLoss}
          onChange={(event) => setStopLoss(event.target.value.replace(/[^\d.]/g, ''))}
          inputMode="decimal"
          placeholder={position.markPrice ?? ''}
          className="num"
        />
        {slWrongSide ? (
          <p className="text-[10.5px] text-[var(--negative)]">
            {t('wrongSideSl', { side: isLong ? t('below') : t('above'), mark: String(mark) })}
          </p>
        ) : slPnl !== null ? (
          <p className="text-[10.5px] text-[var(--text-subtle)]">
            {t('youWouldLose')}{' '}
            <span className="num font-semibold text-[var(--negative)]">{money(slPnl)}</span>
            {share(slPnl) ? (
              <span className="num"> · {t('ofMargin', { pct: share(slPnl)!.replace('-', '') })}</span>
            ) : null}
          </p>
        ) : null}
      </div>

      {crossed ? <Notice tone="warning">{t('crossed')}</Notice> : null}

      {/*
        Said once, plainly. A stop is a trigger, not a fill: it becomes a market
        order when touched, and in a fast market the realised price can be worse
        than the level. Somebody relying on a stop to cap a loss needs to know
        that before they rely on it, not after.
      */}
      <p className="text-[10px] leading-relaxed text-[var(--text-subtle)]">{t('triggerNote')}</p>

      <Button
        variant="secondary"
        size="sm"
        block
        disabled={!valid || busy}
        loading={busy}
        onClick={() => void save()}
      >
        {saved ? t('saved') : t('save')}
      </Button>

      {position.takeProfitPrice || position.stopLossPrice ? (
        <p className={cn('num text-center text-[10px] text-[var(--text-subtle)]')}>
          {t('currentlyAttached', {
            tp: position.takeProfitPrice ?? '—',
            sl: position.stopLossPrice ?? '—',
          })}
        </p>
      ) : null}
    </div>
  );
}
