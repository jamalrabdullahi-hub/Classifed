import { Decimal } from '@flt/core/domain/money';
import { normalCdf } from '@flt/core/protection/zscore';
import { HistoricalStdDev, toDailySigma, INTERVAL_DAYS } from '@flt/core/protection/volatility';
import { calculateExpectedLossPremium } from '@flt/core/protection/expected-loss';
import { waterfallLeverageBound } from '@flt/core/protection/premium';
import type { Candle } from '@flt/core/ports/history';

/**
 * Protection priced in the browser.
 *
 * The pricing is a pure function of three things the page already has: the
 * candles it drew the chart from, the mark price on the ticker, and what the
 * participant typed. Nothing about it is secret and nothing about it depends on
 * server state, so asking the server to recompute it on every keystroke buys
 * nothing and costs a round trip plus a venue candle request each time.
 *
 * These are the *same functions* the server runs, imported from `@flt/core`
 * rather than reimplemented — a second copy of the arithmetic in TypeScript
 * would drift from the first, and the whole engine rests on both halves
 * agreeing to the last digit.
 *
 * The server still prices the trade independently at execution and its answer
 * is the one that binds. This is a preview that happens to be exact, not a
 * substitute for the server's authority.
 */

export type PolicyKind = 'BASE_DAY' | 'BASE_SMOOTH' | 'OMNI';
export type HorizonUnit = 'hours' | 'days' | 'weeks';

export interface HorizonSelection {
  amount: number;
  unit: HorizonUnit;
}

export function horizonToDays({ amount, unit }: HorizonSelection): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (unit === 'hours') return amount / 24;
  if (unit === 'weeks') return amount * 7;
  return amount;
}

/**
 * `unitWords` lets a caller supply localized unit names — `{ hour, hours, day,
 * days, week, weeks }` — since this module has no access to `next-intl`'s `t`.
 * Falls back to English so existing callers keep working unchanged.
 */
export function formatHorizon(
  { amount, unit }: HorizonSelection,
  unitWords?: Record<string, string>,
): string {
  const singular = unit.slice(0, -1);
  const plural = amount === 1 ? singular : unit;
  const word = unitWords?.[plural] ?? unitWords?.[singular] ?? plural;
  return `${amount} ${word}`;
}

/**
 * Coverage expressed in standard deviations.
 *
 * A σ-bound is the honest way to present this. "95% cover" invites the reader
 * to assume the two-tailed 1.96σ when the boundary is one-sided, and the two
 * readings differ by enough to matter. Choosing z directly removes the
 * ambiguity: the boundary sits z standard deviations away over the chosen
 * window, and the confidence that follows is shown rather than assumed.
 */
export const COVERAGE_PRESETS = [
  { z: 1, label: '1σ' },
  { z: 2, label: '2σ' },
  { z: 3, label: '3σ' },
] as const;

export const HORIZON_PRESETS: HorizonSelection[] = [
  { amount: 4, unit: 'hours' },
  { amount: 1, unit: 'days' },
  { amount: 1, unit: 'weeks' },
  { amount: 4, unit: 'weeks' },
  { amount: 26, unit: 'weeks' },
];

/** One-tailed confidence implied by a σ-bound. */
export function confidenceForZ(z: number): number {
  return normalCdf(z);
}

export interface PricingInputs {
  candles: Candle[];
  /** The interval those candles are on, so σ can be scaled to per-day. */
  interval: keyof typeof INTERVAL_DAYS;
  markPrice: string;
  /** Position size in USD. */
  usdNotional: string;
  leverage: number;
  /** Standard deviations to the boundary. */
  z: number;
  horizonDays: number;
  side: 'LONG' | 'SHORT';
  /** The venue's maximum leverage, which sets the maintenance fraction. */
  venueMaxLeverage: number;
  operatorFeeBps: number;
}

export interface Pricing {
  /** σ per day, and the deviation over the selected window. */
  dailySigma: Decimal;
  horizonSigma: Decimal;
  /** D = z·σ·√T. */
  statisticalMove: Decimal;
  boundary: Decimal;
  /** The price move the cover triggers on, as a fraction. */
  coveredMagnitude: Decimal;
  /** P(the boundary is touched within the horizon) = 2(1−Φ(z)). */
  perilProbability: Decimal;
  confidence: number;
  /** What the participant receives on a covered event. */
  indemnity: Decimal;
  contribution: Decimal;
  operatorFee: Decimal;
  totalPremium: Decimal;
  /** Premium as a share of notional. */
  premiumRate: Decimal;
  marginRequired: Decimal;
  estimatedLiquidation: Decimal | null;
  /** Highest leverage at which cover still resolves before the venue does. */
  maxLeverage: number;
  waterfallHolds: boolean;
  /** Margin + premium: everything leaving the wallet. */
  totalToPay: Decimal;
}

export function priceProtection(inputs: PricingInputs): Pricing | null {
  const notional = safeDecimal(inputs.usdNotional);
  const mark = safeDecimal(inputs.markPrice);

  if (!notional || !mark || notional.lessThanOrEqualTo(0) || mark.lessThanOrEqualTo(0)) return null;
  if (!Number.isFinite(inputs.z) || inputs.z <= 0) return null;
  if (!Number.isFinite(inputs.horizonDays) || inputs.horizonDays <= 0) return null;
  if (!Number.isInteger(inputs.leverage) || inputs.leverage < 1) return null;

  const periodDays = INTERVAL_DAYS[inputs.interval];
  if (!periodDays) return null;

  // Needs one more close than returns. Fewer bars than that is not an error
  // worth surfacing in a ticket — the price simply is not ready yet.
  const window = Math.min(inputs.candles.length, 400);
  if (window < 30) return null;

  let dailySigma: Decimal;
  try {
    const estimate = new HistoricalStdDev().calculate(inputs.candles, window, periodDays);
    dailySigma = toDailySigma(estimate);
  } catch {
    return null;
  }

  const horizonDays = new Decimal(inputs.horizonDays);
  const horizonSigma = dailySigma.times(horizonDays.sqrt());
  const z = new Decimal(inputs.z);
  const statisticalMove = z.times(horizonSigma);

  const confidence = confidenceForZ(inputs.z);
  // Guard the edges: Φ(z) reaching 1 in floating point would divide by zero
  // downstream, and a z below the median is not a boundary at all.
  if (!(confidence > 0.5) || confidence >= 1) return null;

  const signed = inputs.side === 'LONG' ? statisticalMove.negated() : statisticalMove;
  const boundary = mark.times(signed.exp());

  const expected = calculateExpectedLossPremium({
    notional,
    statisticalMove,
    percentile: confidence,
  });

  const operatorFee = expected.expectedLoss.times(inputs.operatorFeeBps).dividedBy(10_000);
  const totalPremium = expected.expectedLoss.plus(operatorFee);

  const mmf = new Decimal(1).dividedBy(new Decimal(2).times(inputs.venueMaxLeverage));
  const waterfall = waterfallLeverageBound(statisticalMove, mmf, inputs.side);

  const sign = new Decimal(inputs.side === 'LONG' ? 1 : -1);
  const denominator = new Decimal(1).minus(mmf.times(sign));
  const rawLiquidation = denominator.isZero()
    ? null
    : mark.minus(mark.dividedBy(inputs.leverage).times(sign)).dividedBy(denominator);
  const estimatedLiquidation =
    rawLiquidation && rawLiquidation.greaterThan(0) ? rawLiquidation : null;

  const waterfallHolds = !estimatedLiquidation
    ? true
    : inputs.side === 'LONG'
      ? boundary.greaterThan(estimatedLiquidation)
      : boundary.lessThan(estimatedLiquidation);

  const marginRequired = notional.dividedBy(inputs.leverage);

  return {
    dailySigma,
    horizonSigma,
    statisticalMove,
    boundary,
    coveredMagnitude: expected.coveredMagnitude,
    perilProbability: expected.perilProbability,
    confidence,
    indemnity: expected.indemnity,
    contribution: expected.expectedLoss,
    operatorFee,
    totalPremium,
    premiumRate: totalPremium.dividedBy(notional),
    marginRequired,
    estimatedLiquidation,
    maxLeverage: waterfall.maxWholeLeverage,
    waterfallHolds,
    totalToPay: marginRequired.plus(totalPremium),
  };
}

/** Base Day is a one-day policy by definition; the others take the selection. */
export function horizonForPolicy(kind: PolicyKind, selected: HorizonSelection): HorizonSelection {
  return kind === 'BASE_DAY' ? { amount: 1, unit: 'days' } : selected;
}

function safeDecimal(value: string): Decimal | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  try {
    const decimal = new Decimal(trimmed);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

export { Decimal };
