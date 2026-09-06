import { env } from '@flt/config';
import { Decimal } from '../domain/money';
import { ValidationError } from '../domain/errors';
import { maintenanceMarginFraction, type PerpSide } from '../domain/perps';
import type { PerpCandleInterval, PerpVenue } from '../ports/perps';
import { zScoreForPercentile } from '../protection/zscore';
import { calculatePeril } from '../protection/peril';
import { calculateContribution } from '../protection/contribution';
import {
  calculatePremium,
  contractsForUsd,
  waterfallLeverageBound,
  type Premium,
  type WaterfallBound,
} from '../protection/premium';
import { HistoricalStdDev, INTERVAL_DAYS, toDailySigma } from '../protection/volatility';
import { PROTECTION_DEFAULTS } from './protection';

/**
 * Pricing protection for a position that does not exist yet.
 *
 * This is what the order ticket asks before letting a leveraged trade through.
 * It answers three questions at once, because they are the same question:
 *
 *   1. What would protecting this cost, split into contribution and fee?
 *   2. What is the highest leverage at which insurance still fires before the
 *      venue's margin call — the waterfall?
 *   3. Is the leverage being asked for inside that bound?
 *
 * ## The waterfall, stated plainly
 *
 *   1. insurance
 *   2. margin
 *
 * The participant is taken out by the protection boundary *before* the venue
 * liquidates them. That ordering is the product. It is not achieved by
 * promising it — it is an inequality between two prices, and above a certain
 * leverage it is simply false. So the leverage a participant may choose is
 * capped here, at a bound recomputed from live volatility every time, rather
 * than fixed as a constant that would be wrong on any day but the average one.
 */

/** The percentile presets offered. */
export const PROTECTION_PRESETS = [
  { value: 0.68, label: '68%', note: 'Light cover. The boundary sits close to entry.' },
  { value: 0.95, label: '95%', note: 'Standard cover.' },
  { value: 0.997, label: '99.7%', note: 'Heavy cover. The boundary sits far from entry.' },
] as const;

export const DEFAULT_PRESET = 0.95;

export interface ProtectionQuoteRequest {
  symbol: string;
  side: PerpSide;
  /** Position size in USD — what the participant actually typed. */
  usdNotional: Decimal;
  leverage: number;
  percentile?: number;
  /** Cover horizon in days. One day unless the participant asks for longer. */
  horizonDays?: number;
  interval?: PerpCandleInterval;
  window?: number;
}

export interface ProtectionQuote {
  symbol: string;
  side: PerpSide;
  markPrice: Decimal;
  /** The USD size, and what that is in contracts at the mark. */
  usdNotional: Decimal;
  contracts: Decimal;
  leverage: number;
  /** Margin the venue will require, which is separate from the premium. */
  marginRequired: Decimal;

  percentile: number;
  z: Decimal;
  dailySigma: Decimal;
  horizonDays: Decimal;
  statisticalMove: Decimal;
  boundary: Decimal;
  /** Where the venue would liquidate, at this leverage. */
  estimatedLiquidation: Decimal | null;

  premium: Premium;
  waterfall: WaterfallBound;
  /** True when the boundary is reached before the venue's liquidation price. */
  waterfallHolds: boolean;
  /** Set when the requested leverage breaks the waterfall. */
  refusal: string | null;

  /** Where each half of the premium goes. Null until configured. */
  destinations: {
    pool: string | null;
    operator: string | null;
  };
  /** False until a pool exists that could actually pay a claim. */
  sellable: boolean;
}

export async function quoteProtection(
  venue: PerpVenue,
  request: ProtectionQuoteRequest,
): Promise<ProtectionQuote> {
  const config = env();

  const market = await venue.getMarket(request.symbol);
  if (!market) throw new ValidationError('Unknown market', { symbol: request.symbol });
  if (!market.markPrice) {
    throw new ValidationError('The venue is not quoting this market', { symbol: request.symbol });
  }

  const markPrice = new Decimal(market.markPrice);
  const contracts = contractsForUsd(request.usdNotional, markPrice, market.sizeDecimals);

  if (contracts.lessThan(market.minSize)) {
    throw new ValidationError(
      `That is below the minimum position size of ${market.minSize} ${market.symbol} ` +
        `(about $${markPrice.times(market.minSize).toFixed(2)}).`,
      { minSize: market.minSize },
    );
  }

  const percentile = request.percentile ?? DEFAULT_PRESET;
  const horizonDays = new Decimal(request.horizonDays ?? 1);
  const interval = request.interval ?? PROTECTION_DEFAULTS.interval;
  const window = request.window ?? PROTECTION_DEFAULTS.window;

  const periodDays = INTERVAL_DAYS[interval];
  if (!periodDays) {
    throw new ValidationError('Unsupported candle interval', { interval });
  }

  const candles = await venue.getCandles(market.symbol, interval, window + 1);
  const estimate = new HistoricalStdDev().calculate(candles, window + 1, periodDays);
  const dailySigma = toDailySigma(estimate);

  const z = zScoreForPercentile(percentile);
  const peril = calculatePeril({
    referencePrice: markPrice,
    side: request.side,
    dailySigma,
    horizonDays,
    z,
  });

  // Protection is priced on the position's full value, not on the margin
  // backing it. §12: a 9% underlying move is a 9% peril whatever the leverage,
  // and the exposure being protected is the whole notional.
  const contribution = calculateContribution({
    notional: contracts.times(markPrice),
    statisticalMove: peril.statisticalMove,
  });

  const premium = calculatePremium(contribution, config.PROTECTION_OPERATOR_FEE_BPS);

  // The venue's own maintenance rule, not FLT's leverage cap — liquidation is
  // the venue's decision and depends on its maximum, not on what FLT offers.
  const mmf = new Decimal(maintenanceMarginFraction(market.maxLeverage));
  const waterfall = waterfallLeverageBound(peril.statisticalMove, mmf, request.side);

  const estimatedLiquidation = liquidationAt(markPrice, request.leverage, mmf, request.side);
  const waterfallHolds =
    estimatedLiquidation === null
      ? true
      : request.side === 'LONG'
        ? peril.boundary.greaterThan(estimatedLiquidation)
        : peril.boundary.lessThan(estimatedLiquidation);

  const refusal = waterfallHolds
    ? null
    : `At ${request.leverage}x the venue would liquidate this position at ` +
      `$${estimatedLiquidation!.toFixed(2)}, before protection reaches its boundary at ` +
      `$${peril.boundary.toFixed(2)}. Insurance has to resolve the position first, so ` +
      `${waterfall.maxWholeLeverage}x is the most this cover supports at today's volatility.`;

  return {
    symbol: market.symbol,
    side: request.side,
    markPrice,
    usdNotional: request.usdNotional,
    contracts,
    leverage: request.leverage,
    marginRequired: contracts.times(markPrice).dividedBy(request.leverage),

    percentile,
    z,
    dailySigma,
    horizonDays,
    statisticalMove: peril.statisticalMove,
    boundary: peril.boundary,
    estimatedLiquidation,

    premium,
    waterfall,
    waterfallHolds,
    refusal,

    destinations: {
      pool: config.PROTECTION_POOL_ADDRESS ?? null,
      operator: config.FLT_FEE_RECIPIENT_ADDRESS ?? null,
    },
    // Pricing protection is always allowed; charging for it is not, until
    // there is a pool that could pay a claim.
    sellable: config.PROTECTION_MODE !== 'off' && Boolean(config.PROTECTION_POOL_ADDRESS),
  };
}

/** Whether a leveraged order may proceed at all. */
export function protectionRequired(): boolean {
  return env().PROTECTION_MODE === 'required';
}

/**
 * liq = entry·(1 ∓ 1/L) / (1 ∓ mmf), the same expression as
 * `estimateLiquidationPrice` but taking the maintenance fraction directly.
 * Null when no adverse price liquidates the position — a 1x long.
 */
function liquidationAt(
  entry: Decimal,
  leverage: number,
  mmf: Decimal,
  side: PerpSide,
): Decimal | null {
  const sign = new Decimal(side === 'LONG' ? 1 : -1);
  const denominator = new Decimal(1).minus(mmf.times(sign));
  if (denominator.isZero()) return null;

  const liquidation = entry.minus(entry.dividedBy(leverage).times(sign)).dividedBy(denominator);
  return liquidation.greaterThan(0) ? liquidation : null;
}
