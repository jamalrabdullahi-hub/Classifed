import { createHash } from 'node:crypto';
import { Decimal } from '../domain/money';
import { ValidationError } from '../domain/errors';
import { buildQuoteLadder } from './quoting';

/**
 * The market-making runner's decision, as a pure function.
 *
 * Nothing here reaches a venue, holds a key or writes anything. It answers one
 * question — "given where the market is, what the book holds, and what is
 * already resting, what should the book cancel and place this cycle?" — and
 * answers it deterministically, so the whole decision can be unit-tested and the
 * thing that actually signs (the worker, via the agent key) does no thinking of
 * its own. See docs/adr/0007.
 *
 * Two rules are load-bearing and live here rather than in the worker:
 *
 *   - **The kill switch.** A realized loss past the daily cap cancels every
 *     resting quote and places nothing. It is checked before the ladder is even
 *     built, so a halted book cannot widen its way out of trouble.
 *   - **Idempotent requoting.** A quote's client order id is derived
 *     deterministically from its symbol, side and price, so the same desired
 *     quote always carries the same id. A crash between cancel and place cannot
 *     double-rest; the venue rejects the second id.
 */

const BPS = new Decimal(10_000);
/** How strongly volatility widens the quote. A constant until it needs tuning. */
const VOLATILITY_MULTIPLE = new Decimal('1');
/** How far a full inventory shifts the ladder, as a fraction of price. */
const INVENTORY_SKEW = new Decimal('0.02');

export interface MakerRunnerConfig {
  /** Half the base spread, in basis points. */
  halfSpreadBps: number;
  /** How many levels each side. */
  levels: number;
  /** Size per level, in contracts. */
  levelSize: string;
  /** Extra spread added per level, in basis points. */
  levelStepBps: number;
  /** The most the book will hold, in contracts. */
  maxInventory: string;
  /** The most the book may lose in a day, in USD. */
  maxDailyLossUsd: string;
}

/** A resting order, as the venue reports it, reduced to what the plan needs. */
export interface MakerRunnerOpenOrder {
  cloid: string;
  isBuy: boolean;
  price: string;
  size: string;
}

export interface MakerRunnerState {
  /** The venue's mark. */
  midPrice: string;
  /** Per-period volatility as a fraction (0.01 = 1%). */
  volatility: string;
  /** Signed inventory in contracts. Positive is long. */
  inventory: string;
  /** Realized result so far today, net of fees, in USD. Signed. */
  realizedPnlTodayUsd: string;
  /** The orders currently resting at the venue. */
  openOrders: MakerRunnerOpenOrder[];
}

export interface PlannedQuote {
  symbol: string;
  isBuy: boolean;
  price: string;
  size: string;
  cloid: string;
}

export interface PlannedCancel {
  symbol: string;
  cloid: string;
}

export interface RequotePlan {
  /** Set when the book must stop. The runner cancels its quotes and places none. */
  halt: { reason: string } | null;
  cancel: PlannedCancel[];
  place: PlannedQuote[];
}

/**
 * The client order id for a quote.
 *
 * Deterministic in (symbol, side, price): the same quote yields the same id
 * every time, which is what makes a retried requote idempotent at the venue.
 */
export function cloidFor(symbol: string, isBuy: boolean, price: string): string {
  const digest = createHash('sha256').update(`${symbol}|${isBuy ? 'B' : 'A'}|${price}`).digest('hex');
  return `0x${digest.slice(0, 32)}`;
}

/** What to cancel and place this cycle, or a halt. Pure; no side effects. */
export function planRequote(params: {
  symbol: string;
  config: MakerRunnerConfig;
  state: MakerRunnerState;
}): RequotePlan {
  const { symbol, config, state } = params;

  const midPrice = new Decimal(state.midPrice);
  if (!midPrice.isFinite() || midPrice.lessThanOrEqualTo(0)) {
    throw new ValidationError('Mid price must be positive', { midPrice: state.midPrice });
  }

  const cancelAll: PlannedCancel[] = state.openOrders.map((order) => ({
    symbol,
    cloid: order.cloid,
  }));

  // The kill switch, checked before anything else. A loss past the cap stops
  // the book and pulls its quotes; it never quotes further into the hole.
  const lossToday = new Decimal(state.realizedPnlTodayUsd);
  const dailyLossLimit = new Decimal(config.maxDailyLossUsd);
  if (lossToday.isNegative() && lossToday.negated().greaterThanOrEqualTo(dailyLossLimit)) {
    return {
      halt: {
        reason: `realized loss ${lossToday.abs().toFixed()} reached the daily limit ${dailyLossLimit.toFixed()}`,
      },
      cancel: cancelAll,
      place: [],
    };
  }

  const ladder = buildQuoteLadder({
    midPrice,
    baseHalfSpread: new Decimal(config.halfSpreadBps).dividedBy(BPS),
    volatility: new Decimal(state.volatility),
    volatilityMultiple: VOLATILITY_MULTIPLE,
    inventory: new Decimal(state.inventory),
    maxInventory: new Decimal(config.maxInventory),
    inventorySkew: INVENTORY_SKEW,
    levelSize: new Decimal(config.levelSize),
    levels: config.levels,
    levelStep: new Decimal(config.levelStepBps).dividedBy(BPS),
  });

  const desired: PlannedQuote[] = [...ladder.bids, ...ladder.asks].map((level) => {
    const isBuy = level.side === 'LONG';
    const price = level.price.toFixed();
    return { symbol, isBuy, price, size: level.size.toFixed(), cloid: cloidFor(symbol, isBuy, price) };
  });

  /**
   * Diff against what is resting. A resting order is kept when its side and
   * price match a desired quote — size is fixed by config, so a size change
   * also changes the price and is caught here. Everything else is cancelled and
   * re-placed, which is the ordinary way a maker moves a ladder.
   */
  const desiredKeys = new Set(desired.map((q) => `${q.isBuy ? 'B' : 'A'}|${q.price}`));
  const restingKeys = new Set<string>();
  const cancel: PlannedCancel[] = [];
  for (const order of state.openOrders) {
    const key = `${order.isBuy ? 'B' : 'A'}|${order.price}`;
    if (desiredKeys.has(key)) restingKeys.add(key);
    else cancel.push({ symbol, cloid: order.cloid });
  }

  const place = desired.filter((quote) => !restingKeys.has(`${quote.isBuy ? 'B' : 'A'}|${quote.price}`));

  return { halt: null, cancel, place };
}
