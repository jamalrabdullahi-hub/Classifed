import { Decimal } from './money';
import { ValidationError } from './errors';

/**
 * Perpetual futures — types and position arithmetic.
 *
 * ## Why the numbers here are shaped differently from spot
 *
 * The spot path carries token amounts as base-unit integer strings, because an
 * ERC-20 transfer is an integer count of a token's smallest unit and rounding
 * one is a real loss. Perpetual venues do not work that way: a position is a
 * quantity of a synthetic contract quoted against a USD price, and the venues
 * report sizes, prices and margin as human-scaled decimal strings. Forcing
 * those through the base-unit helpers would mean inventing a decimals value
 * that does not exist.
 *
 * So this module speaks decimal strings and does its arithmetic in `Decimal`.
 * The rule that carries over unchanged is the one that matters: **never a JS
 * float.** A `number` appears here only for leverage and basis points, which
 * are small integers by construction.
 *
 * ## Estimates are labelled as estimates
 *
 * Every venue computes liquidation using its own margin tiers, its own
 * maintenance schedule, and an account state we do not hold a copy of. Our
 * arithmetic cannot be authoritative about it, and a liquidation price is
 * exactly the kind of number a user makes an irreversible decision on.
 *
 * The rule, mirroring how price impact is handled on the spot path: when the
 * venue reports a liquidation price for a live position, that number wins and
 * ours is never shown. Ours exists only to preview a position that does not
 * exist yet, and every caller must present it as an estimate.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type PerpSide = 'LONG' | 'SHORT';

/**
 * Isolated confines losses to the margin posted against one position. Cross
 * shares the whole account balance, so an adverse move on one market can
 * liquidate an unrelated position. Both are offered because both are standard,
 * but the interface must never let a user pick cross without saying that.
 */
export type MarginMode = 'ISOLATED' | 'CROSS';

/** Which direction a side profits in. Long earns as price rises. */
export function sideSign(side: PerpSide): 1 | -1 {
  return side === 'LONG' ? 1 : -1;
}

export interface PerpMarket {
  /** Venue-native symbol, e.g. "BTC", "ETH". */
  symbol: string;
  /** Human name for display, e.g. "Bitcoin". */
  name: string;

  /**
   * The venue's own identifier for this market, carried explicitly rather than
   * derived from position in a list.
   *
   * This matters more than it looks. On Hyperliquid the asset id *is* the index
   * into the universe array, so it is tempting to recover it with a `findIndex`
   * at order time. Any caller that filters the list first — dropping delisted
   * markets, say, which is the obvious thing to do — silently shifts every
   * index after the first gap, and an order for one market is submitted against
   * a different one. Resolving it once, where the venue's own ordering is
   * still intact, makes that class of mistake unrepresentable.
   */
  venueAssetId: number;
  /** The venue's ceiling. FLT may impose a lower cap on top of this. */
  maxLeverage: number;
  /** Decimal places the venue accepts for a size on this market. */
  sizeDecimals: number;
  /** Smallest tradeable size, as a decimal string. */
  minSize: string;
  /** Oracle/index price, decimal string. */
  indexPrice: string | null;
  /**
   * The price the venue marks positions against, which is what PnL and
   * liquidation are computed from. Distinct from index and from last trade.
   */
  markPrice: string | null;
  /**
   * Funding rate for the current interval, as a decimal fraction (not bps and
   * not a percentage): 0.0000125 is 0.00125% per interval. Positive means longs
   * pay shorts.
   */
  fundingRate: string | null;
  /** Length of one funding interval in hours. Hyperliquid pays hourly. */
  fundingIntervalHours: number;
  /** Total open interest in contracts, decimal string. */
  openInterest: string | null;
  /** True when the venue has halted or delisted the market. */
  isDelisted: boolean;

  /**
   * What the contract tracks.
   *
   * A perp is a synthetic, so the underlying need not be crypto. A venue can
   * list equities, indices, FX and commodities that settle in stablecoins and
   * trade like any other contract.
   */
  assetClass: PerpAssetClass;

  /**
   * Whether the underlying's market is open right now.
   *
   * Crypto never closes, so on a crypto-only venue this is always true and easy
   * to forget. It is not forgettable on an equity or FX contract: the market
   * shuts on evenings and weekends, the position stays open across the gap, and
   * a trader who cannot see that the session is closed will read a frozen price
   * as a quiet market rather than a shut one.
   *
   * Null when the venue does not report it.
   */
  isMarketOpen: boolean | null;
  /** Seconds until the session state flips, when the venue reports it. */
  secondsToSessionChange: number | null;
}

export type PerpAssetClass = 'CRYPTO' | 'EQUITY' | 'FUTURE' | 'FOREX' | 'COMMODITY';

/** How each class reads to a trader, for labelling. */
export const ASSET_CLASS_LABELS: Record<PerpAssetClass, string> = {
  CRYPTO: 'Crypto',
  EQUITY: 'Stocks',
  FUTURE: 'Indices',
  FOREX: 'Forex',
  COMMODITY: 'Commodities',
};

export interface PerpPosition {
  symbol: string;
  side: PerpSide;
  /** Absolute position size in contracts. Always positive; `side` carries direction. */
  size: string;
  /** Volume-weighted entry price. */
  entryPrice: string;
  /** Margin currently backing the position, in USD. */
  margin: string;
  marginMode: MarginMode;
  leverage: number;

  /**
   * The venue's own liquidation price. Authoritative — never overwrite this
   * with a locally computed estimate.
   *
   * Null when the venue does not report one, which for a cross-margin position
   * can legitimately mean "not liquidatable at any price of this asset alone".
   */
  liquidationPrice: string | null;

  /** The venue's unrealized PnL, in USD. Preferred over recomputing. */
  unrealizedPnl: string | null;
  /** Cumulative funding paid (positive) or received (negative), in USD. */
  fundingPaid: string | null;
}

/** What the user asked for, before it becomes a signable action. */
export type PerpOrderType =
  | 'MARKET'
  | 'LIMIT'
  | 'STOP_MARKET'
  | 'STOP_LIMIT'
  | 'TAKE_PROFIT_MARKET'
  | 'TAKE_PROFIT_LIMIT';

/** True for the four types that wait off the book for a trigger price. */
export function isTriggerOrder(type: PerpOrderType): boolean {
  return type !== 'MARKET' && type !== 'LIMIT';
}

/** True for the two that rest as a limit once triggered. */
export function triggerRestsAsLimit(type: PerpOrderType): boolean {
  return type === 'STOP_LIMIT' || type === 'TAKE_PROFIT_LIMIT';
}

export interface PerpOrderIntent {
  symbol: string;
  side: PerpSide;
  /** How the order reaches the book. Defaults to MARKET. */
  orderType?: PerpOrderType;
  /** Required for the trigger types; meaningless for MARKET and LIMIT. */
  triggerPrice?: string | null;
  /**
   * A bracket's protective legs, submitted with the entry.
   *
   * Both are reduce-only and cancel each other when one fills. Sent with the
   * entry rather than after it, because a fill between two requests leaves the
   * position unprotected for exactly the moment the stop was bought for.
   */
  takeProfitPrice?: string | null;
  stopLossPrice?: string | null;
  /** Contracts, decimal string. */
  size: string;
  leverage: number;
  marginMode: MarginMode;
  /**
   * Limit price, or null for a market order. A market order is still submitted
   * to the venue with a bounded acceptable price — see `slippageBps`.
   */
  limitPrice: string | null;
  /** Tolerance applied to a market order before it is sent. */
  slippageBps: number;
  /** Close-only: never increases exposure, only reduces or flattens. */
  reduceOnly: boolean;
  /**
   * The protection percentile the participant chose, when protection is being
   * bought alongside the trade. Absent on a close or an unleveraged open,
   * neither of which requires cover.
   */
  protectionPercentile?: number;
}

// ── Position arithmetic ─────────────────────────────────────────────────────

function decimal(value: string, field: string): Decimal {
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) {
    throw new ValidationError(`${field} must be a finite decimal`, { value });
  }
  return parsed;
}

function positiveDecimal(value: string, field: string): Decimal {
  const parsed = decimal(value, field);
  if (parsed.lessThanOrEqualTo(0)) {
    throw new ValidationError(`${field} must be greater than zero`, { value });
  }
  return parsed;
}

export function assertLeverage(leverage: number, max: number): number {
  if (!Number.isInteger(leverage) || leverage < 1) {
    throw new ValidationError('Leverage must be a whole number of at least 1', { leverage });
  }
  if (leverage > max) {
    throw new ValidationError(`Leverage above ${max}x is not available on this market`, {
      leverage,
      max,
    });
  }
  return leverage;
}

/** Position value at a given price: size × price. */
export function notional(size: string, price: string): string {
  return positiveDecimal(size, 'size').times(positiveDecimal(price, 'price')).toFixed();
}

/**
 * Collateral required to open, before fees: notional / leverage.
 *
 * This is what the user must have free. It is not what they can lose — that is
 * bounded by the margin only for an isolated position, and is unbounded across
 * the account for a cross one.
 */
export function initialMargin(size: string, price: string, leverage: number): string {
  assertLeverage(leverage, Number.MAX_SAFE_INTEGER);
  return new Decimal(notional(size, price)).dividedBy(leverage).toFixed();
}

/**
 * Maintenance margin: the floor below which the position is liquidated.
 *
 * Expressed as a fraction of notional.
 *
 * The default rule — half the initial margin required at the market's maximum
 * leverage, so a 40x market maintains at 1/80 of notional — is **Hyperliquid's
 * rule, not a universal one**. Most venues use a tiered schedule where the
 * fraction rises with position size, and several use a flat per-market rate
 * unrelated to max leverage. This module is venue-agnostic, so the rule is an
 * argument with a documented default rather than an assumption baked into the
 * arithmetic.
 *
 * `override` is a fraction of notional supplied by the venue adapter, and wins
 * outright when present. A venue-reported value always beats a derived one,
 * exactly as with liquidation prices.
 */
export function maintenanceMarginFraction(
  maxLeverage: number,
  override?: string | null,
): string {
  if (override !== undefined && override !== null) {
    const fraction = new Decimal(override);
    if (!fraction.isFinite() || fraction.isNegative() || fraction.greaterThanOrEqualTo(1)) {
      throw new ValidationError(
        'Maintenance margin fraction must be a fraction of notional in [0, 1)',
        { override },
      );
    }
    return fraction.toFixed();
  }

  if (!Number.isInteger(maxLeverage) || maxLeverage < 1) {
    throw new ValidationError('Max leverage must be a whole number of at least 1', { maxLeverage });
  }
  return new Decimal(1).dividedBy(new Decimal(maxLeverage).times(2)).toFixed();
}

export function maintenanceMargin(
  size: string,
  price: string,
  maxLeverage: number,
  maintenanceFraction?: string | null,
): string {
  return new Decimal(notional(size, price))
    .times(maintenanceMarginFraction(maxLeverage, maintenanceFraction))
    .toFixed();
}

/**
 * Unrealized PnL in USD.
 *
 * Long profits as the mark rises, short as it falls. Uses mark rather than last
 * traded price because mark is what the venue liquidates against, and showing a
 * profit against a price that cannot save you from liquidation is a lie.
 */
export function unrealizedPnl(
  side: PerpSide,
  size: string,
  entryPrice: string,
  markPrice: string,
): string {
  const move = positiveDecimal(markPrice, 'markPrice').minus(
    positiveDecimal(entryPrice, 'entryPrice'),
  );
  return move.times(positiveDecimal(size, 'size')).times(sideSign(side)).toFixed();
}

/** PnL as a fraction of margin posted. 0.5 means the position is up 50% on margin. */
export function returnOnMargin(pnl: string, margin: string): string {
  const posted = positiveDecimal(margin, 'margin');
  return decimal(pnl, 'pnl').dividedBy(posted).toFixed();
}

/**
 * Estimated liquidation price for a position that does not exist yet.
 *
 * **This is an estimate and must be labelled as one wherever it is shown.** It
 * assumes an isolated position, no fees, no funding accrued, and the venue's
 * standard maintenance fraction. A live position's real liquidation price comes
 * from the venue and differs — funding accrues against it every interval, and a
 * cross-margin position depends on the rest of the account entirely.
 *
 * Derivation, for a long: liquidation is where equity falls to maintenance.
 * Writing m for margin per contract (entry / leverage) and mmf for the
 * maintenance fraction, and dividing through by size:
 *
 *     m + (liq − entry) = liq × mmf
 *     liq × (1 − mmf)   = entry − m
 *     liq               = (entry − m) / (1 − mmf)
 *
 * A short is the same statement with the direction of the loss reversed, which
 * gives (entry + m) / (1 + mmf). Both collapse to the single expression below
 * using the side's sign. Note the subtraction sits inside the division — moving
 * it outside understates a long's liquidation price by roughly the maintenance
 * fraction, which is precisely the margin of safety a user is relying on.
 *
 * Size cancels out entirely, so the estimate does not depend on how large the
 * position is — only on entry, leverage and the market's maintenance schedule.
 *
 * Returns null when the position cannot be liquidated by an adverse move in
 * this asset — for a long at 1x, where the margin covers the entire notional
 * and only a price of zero wipes it out.
 */
export function estimateLiquidationPrice(params: {
  side: PerpSide;
  entryPrice: string;
  leverage: number;
  maxLeverage: number;
  /** Venue-reported maintenance fraction, when it publishes one. Wins if set. */
  maintenanceFraction?: string | null;
}): string | null {
  const entry = positiveDecimal(params.entryPrice, 'entryPrice');
  assertLeverage(params.leverage, params.maxLeverage);

  const mmf = new Decimal(
    maintenanceMarginFraction(params.maxLeverage, params.maintenanceFraction),
  );
  const sign = new Decimal(sideSign(params.side));

  const marginPerContract = entry.dividedBy(params.leverage);
  const denominator = new Decimal(1).minus(mmf.times(sign));
  if (denominator.isZero()) return null;

  const liquidation = entry.minus(marginPerContract.times(sign)).dividedBy(denominator);

  if (liquidation.lessThanOrEqualTo(0)) return null;

  // Deliberately unrounded. This is the arithmetic, and the test that guards it
  // asserts equity falls exactly to the maintenance requirement — a tolerance
  // that rounding here would force us to loosen. Rounding is a reporting
  // concern and happens at the boundary; see `resolveLiquidation`.
  return liquidation.toFixed();
}

/**
 * How close a position is to liquidation, as a fraction of the distance from
 * entry: 0 means at entry, 1 means at the liquidation price.
 *
 * Exists so the interface can escalate visually — a position 90% of the way to
 * liquidation should not look like one at 10%.
 */
export function liquidationProximity(
  markPrice: string,
  entryPrice: string,
  liquidationPrice: string,
): string {
  const mark = positiveDecimal(markPrice, 'markPrice');
  const entry = positiveDecimal(entryPrice, 'entryPrice');
  const liquidation = positiveDecimal(liquidationPrice, 'liquidationPrice');

  const span = entry.minus(liquidation);
  if (span.isZero()) return '1';

  const travelled = entry.minus(mark).dividedBy(span);
  if (travelled.lessThan(0)) return '0';
  if (travelled.greaterThan(1)) return '1';
  return travelled.toFixed();
}

/**
 * Funding owed for one interval. Positive means the trader pays.
 *
 * Longs pay shorts when the rate is positive, and the sign flips for a short
 * position — which is why this is not simply notional × rate.
 */
export function fundingPayment(params: {
  side: PerpSide;
  size: string;
  markPrice: string;
  fundingRate: string;
}): string {
  return new Decimal(notional(params.size, params.markPrice))
    .times(decimal(params.fundingRate, 'fundingRate'))
    .times(sideSign(params.side))
    .toFixed();
}

/** Annualised funding, for comparing markets. A rate per interval is not comparable across venues. */
export function annualisedFundingRate(fundingRate: string, intervalHours: number): string {
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
    throw new ValidationError('Funding interval must be a positive number of hours', {
      intervalHours,
    });
  }
  const intervalsPerYear = new Decimal(24).dividedBy(intervalHours).times(365);
  return decimal(fundingRate, 'fundingRate').times(intervalsPerYear).toFixed();
}
