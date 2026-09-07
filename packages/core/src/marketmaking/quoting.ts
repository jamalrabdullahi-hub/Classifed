import { Decimal } from '../domain/money';
import { ValidationError } from '../domain/errors';
import type { PerpSide } from '../domain/perps';

/**
 * Quote generation for a passive market maker.
 *
 * ## What a market maker is actually paid for
 *
 * Not for predicting the price. A maker earns the spread from traders who want
 * immediacy, and pays for it through adverse selection — the flow that hits a
 * quote is, on average, the flow that knows something. Everything here is
 * arranged around surviving that: quotes widen with volatility, skew away from
 * inventory already held, and stop entirely when the position is too large.
 *
 * ## Inventory skew is the whole game
 *
 * A maker holding a long position wants to sell more than it buys, so its bid
 * moves down and its ask moves down with it. Without skew, a maker in a trending
 * market accumulates the losing side of every move until it is liquidated —
 * which is the ordinary way an under-capitalised maker dies, not a rare one.
 *
 * ## Nothing here signs anything
 *
 * This module computes prices. It holds no key, reaches no venue, and cannot
 * place an order. Whether those prices are ever sent is a separate decision
 * made somewhere that has the authority to make it.
 */

export interface QuoteParams {
  /** The venue's mark. Quotes are placed around this, never around the last fill. */
  midPrice: Decimal;
  /**
   * Half the base spread, as a fraction. 0.0005 quotes 5 bps either side.
   *
   * The floor, not the answer: volatility and inventory both widen it.
   */
  baseHalfSpread: Decimal;
  /** Per-period standard deviation of returns, used to widen in fast markets. */
  volatility: Decimal;
  /** How strongly volatility widens the quote. */
  volatilityMultiple: Decimal;

  /** Signed inventory in contracts. Positive is long. */
  inventory: Decimal;
  /** The largest position the maker will hold before it stops adding. */
  maxInventory: Decimal;
  /**
   * How far a full inventory shifts the quote, as a fraction of price.
   *
   * At the limit the whole ladder moves this far against the position, which is
   * what makes the maker pay up to get flat rather than waiting to be right.
   */
  inventorySkew: Decimal;

  /** Size per level, in contracts. */
  levelSize: Decimal;
  /** How many levels each side. */
  levels: number;
  /** Extra spread added per level away from the touch. */
  levelStep: Decimal;
}

export interface QuoteLevel {
  side: PerpSide;
  price: Decimal;
  size: Decimal;
  /** Distance from mid, in basis points. Reported so a ladder can be read. */
  offsetBps: Decimal;
}

export interface QuoteLadder {
  midPrice: Decimal;
  /** The half-spread actually used, after volatility. */
  effectiveHalfSpread: Decimal;
  /** How far the ladder was shifted by inventory, as a fraction. */
  skew: Decimal;
  /** Inventory as a fraction of the limit, in [-1, 1]. */
  inventoryRatio: Decimal;
  bids: QuoteLevel[];
  asks: QuoteLevel[];
  /** Set when one side is deliberately not quoted. */
  suppressed: { bids: string | null; asks: string | null };
}

export function buildQuoteLadder(params: QuoteParams): QuoteLadder {
  const {
    midPrice,
    baseHalfSpread,
    volatility,
    volatilityMultiple,
    inventory,
    maxInventory,
    inventorySkew,
    levelSize,
    levels,
    levelStep,
  } = params;

  if (!midPrice.isFinite() || midPrice.lessThanOrEqualTo(0)) {
    throw new ValidationError('Mid price must be positive', { midPrice: midPrice.toString() });
  }
  if (baseHalfSpread.isNegative()) {
    throw new ValidationError('Half-spread cannot be negative');
  }
  if (maxInventory.lessThanOrEqualTo(0)) {
    throw new ValidationError('Maximum inventory must be positive');
  }
  if (!Number.isInteger(levels) || levels < 1 || levels > 20) {
    throw new ValidationError('Levels must be a whole number between 1 and 20', { levels });
  }

  /**
   * Widening with volatility.
   *
   * A fixed spread is a promise to trade at yesterday's price in today's
   * market, and the trader taking that quote is the one who noticed first.
   */
  const effectiveHalfSpread = baseHalfSpread.plus(volatility.times(volatilityMultiple));

  // Clipped: inventory can exceed the limit through a fill that straddles it,
  // and an unclipped ratio would skew the ladder past the mid.
  const rawRatio = inventory.dividedBy(maxInventory);
  const inventoryRatio = rawRatio.greaterThan(1)
    ? new Decimal(1)
    : rawRatio.lessThan(-1)
      ? new Decimal(-1)
      : rawRatio;

  // A long position pushes both sides down, so buying gets less attractive and
  // selling gets more so.
  const skew = inventoryRatio.times(inventorySkew).negated();

  const atLimitLong = inventoryRatio.greaterThanOrEqualTo(1);
  const atLimitShort = inventoryRatio.lessThanOrEqualTo(-1);

  const bids: QuoteLevel[] = [];
  const asks: QuoteLevel[] = [];

  for (let level = 0; level < levels; level += 1) {
    const step = levelStep.times(level);
    const offset = effectiveHalfSpread.plus(step);

    if (!atLimitLong) {
      const price = midPrice.times(new Decimal(1).minus(offset).plus(skew));
      if (price.greaterThan(0)) {
        bids.push({
          side: 'LONG',
          price,
          size: levelSize,
          offsetBps: midPrice.minus(price).dividedBy(midPrice).times(10_000),
        });
      }
    }

    if (!atLimitShort) {
      const price = midPrice.times(new Decimal(1).plus(offset).plus(skew));
      asks.push({
        side: 'SHORT',
        price,
        size: levelSize,
        offsetBps: price.minus(midPrice).dividedBy(midPrice).times(10_000),
      });
    }
  }

  return {
    midPrice,
    effectiveHalfSpread,
    skew,
    inventoryRatio,
    bids,
    asks,
    suppressed: {
      bids: atLimitLong
        ? 'Long inventory is at the limit, so the maker is not bidding.'
        : null,
      asks: atLimitShort
        ? 'Short inventory is at the limit, so the maker is not offering.'
        : null,
    },
  };
}

// ── Capital ─────────────────────────────────────────────────────────────────

export interface CapitalRequirement {
  /** Notional the maker must be able to carry at full inventory. */
  maxNotional: Decimal;
  /** Margin that notional needs at the chosen leverage. */
  marginRequired: Decimal;
  /**
   * Margin plus a buffer for adverse movement before the position is flat.
   *
   * A maker running at exactly its margin requirement is liquidated by the
   * first move against it, which is the move that filled it in the first place.
   */
  recommendedCapital: Decimal;
  /** The buffer, as a multiple of margin. */
  bufferMultiple: Decimal;
}

/**
 * What it costs to run the book.
 *
 * The number people underestimate. A maker quoting $5,000 a side across five
 * levels is not risking $5,000 — it is risking the full inventory it can
 * accumulate before it stops quoting, which is every level on one side, and it
 * needs to survive the move that filled all of them.
 */
export function capitalRequired(params: {
  maxInventory: Decimal;
  price: Decimal;
  leverage: number;
  /** Multiple of margin held spare. Three is not conservative. */
  bufferMultiple?: Decimal;
}): CapitalRequirement {
  const { maxInventory, price, leverage } = params;
  const bufferMultiple = params.bufferMultiple ?? new Decimal(3);

  if (leverage < 1) throw new ValidationError('Leverage must be at least 1');

  const maxNotional = maxInventory.times(price);
  const marginRequired = maxNotional.dividedBy(leverage);

  return {
    maxNotional,
    marginRequired,
    recommendedCapital: marginRequired.times(bufferMultiple),
    bufferMultiple,
  };
}

// ── Expected economics ──────────────────────────────────────────────────────

export interface MakerEconomics {
  /** Spread captured per round trip, as a fraction of notional. */
  edgePerRoundTrip: Decimal;
  /** Gross spread income over the period. */
  grossSpread: Decimal;
  /** What adverse selection is expected to take back. */
  adverseSelectionCost: Decimal;
  /** Venue fees paid on both sides. */
  venueFees: Decimal;
  netProfit: Decimal;
  /** Net as a fraction of the capital tied up. */
  returnOnCapital: Decimal;
}

/**
 * What the book earns, and what takes it back.
 *
 * Three terms, and the second is the one that decides whether a maker is a
 * business or a slow donation:
 *
 *   **Spread.** Half-spread twice per round trip, times the volume filled.
 *   **Adverse selection.** The flow that hits a quote is not random. A maker
 *     buys just before the price falls more often than chance, and the cost of
 *     that scales with volatility — not with the spread earned.
 *   **Fees.** Paid on both legs, whatever the venue charges a maker.
 *
 * `adverseSelectionFactor` is the fraction of a typical move the maker gives
 * back on a filled trade. It is an assumption, not a measurement, and the
 * caller states it explicitly so nobody mistakes the output for a forecast.
 */
export function estimateMakerEconomics(params: {
  /** Volume the maker expects to fill, in notional. */
  filledNotional: Decimal;
  effectiveHalfSpread: Decimal;
  /** Per-period volatility over the holding period of a typical position. */
  volatility: Decimal;
  /** How much of a typical move is lost to informed flow, in [0, 1]. */
  adverseSelectionFactor: Decimal;
  /** Venue maker fee in basis points. Negative for a rebate. */
  makerFeeBps: number;
  capital: Decimal;
}): MakerEconomics {
  const {
    filledNotional,
    effectiveHalfSpread,
    volatility,
    adverseSelectionFactor,
    makerFeeBps,
    capital,
  } = params;

  // Both legs of a round trip earn the half-spread.
  const edgePerRoundTrip = effectiveHalfSpread.times(2);
  const grossSpread = filledNotional.times(edgePerRoundTrip);

  const adverseSelectionCost = filledNotional.times(volatility).times(adverseSelectionFactor);
  const venueFees = filledNotional.times(makerFeeBps).dividedBy(10_000).times(2);

  const netProfit = grossSpread.minus(adverseSelectionCost).minus(venueFees);

  return {
    edgePerRoundTrip,
    grossSpread,
    adverseSelectionCost,
    venueFees,
    netProfit,
    returnOnCapital: capital.isZero() ? new Decimal(0) : netProfit.dividedBy(capital),
  };
}
