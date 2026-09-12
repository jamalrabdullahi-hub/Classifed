import type { Candle } from '@flt/core/ports';

/**
 * Chart indicators, computed on the client.
 *
 * Pure functions over candles, and a small policy that says which of them a
 * subscription tier may use. Kept free of any `@flt/db` import so the terminal —
 * a client component — can pull the maths without dragging the Prisma client
 * into the browser bundle; the policy takes a plain tier string, not the enum.
 *
 * Overlay indicators only (they draw on the price pane). Oscillators like RSI
 * or MACD need their own pane, which is a larger change and not attempted here.
 */

export type IndicatorType = 'sma' | 'ema' | 'bb';

export interface IndicatorSpec {
  /** Stable id, so a series is updated rather than recreated. */
  id: string;
  type: IndicatorType;
  period: number;
}

export interface IndicatorPoint {
  time: number; // seconds, matching the candle time
  value: number;
}

export interface IndicatorLine {
  /** Unique across all indicators on one chart, e.g. `<id>:u` for a BB band. */
  key: string;
  points: IndicatorPoint[];
}

export const INDICATOR_TYPES: Record<IndicatorType, { label: string; defaultPeriod: number }> = {
  sma: { label: 'SMA', defaultPeriod: 20 },
  ema: { label: 'EMA', defaultPeriod: 20 },
  bb: { label: 'BB', defaultPeriod: 20 },
};

const ALL_TYPES: IndicatorType[] = ['sma', 'ema', 'bb'];

/**
 * What a tier may add to a chart.
 *
 * FREE gets a single simple moving average — enough to read a trend, not the
 * toolkit. BASIC gets the set, three at a time. PRO and ELITE get ten. The
 * numbers are the product decision; the maths is the same for everyone.
 */
export function indicatorPolicyFor(tier: string): { allowed: IndicatorType[]; max: number } {
  switch (tier) {
    case 'BASIC':
      return { allowed: ALL_TYPES, max: 3 };
    case 'PRO':
    case 'ELITE':
      return { allowed: ALL_TYPES, max: 10 };
    case 'FREE':
    default:
      return { allowed: ['sma'], max: 1 };
  }
}

/** Simple moving average of closes. */
export function sma(candles: Candle[], period: number): IndicatorPoint[] {
  if (period < 1 || candles.length < period) return [];

  const out: IndicatorPoint[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    sum += candles[i]!.close;
    if (i >= period) sum -= candles[i - period]!.close;
    if (i >= period - 1) out.push({ time: candles[i]!.time, value: sum / period });
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first window. */
export function ema(candles: Candle[], period: number): IndicatorPoint[] {
  if (period < 1 || candles.length < period) return [];

  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i += 1) prev += candles[i]!.close;
  prev /= period;

  const out: IndicatorPoint[] = [{ time: candles[period - 1]!.time, value: prev }];
  for (let i = period; i < candles.length; i += 1) {
    prev = candles[i]!.close * k + prev * (1 - k);
    out.push({ time: candles[i]!.time, value: prev });
  }
  return out;
}

/** Bollinger bands: a moving average with ±`mult` population standard deviations. */
export function bollinger(
  candles: Candle[],
  period: number,
  mult = 2,
): { middle: IndicatorPoint[]; upper: IndicatorPoint[]; lower: IndicatorPoint[] } {
  const middle = sma(candles, period);
  const upper: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];

  for (let i = period - 1; i < candles.length; i += 1) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j += 1) mean += candles[j]!.close;
    mean /= period;

    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) variance += (candles[j]!.close - mean) ** 2;
    const sd = Math.sqrt(variance / period);

    upper.push({ time: candles[i]!.time, value: mean + mult * sd });
    lower.push({ time: candles[i]!.time, value: mean - mult * sd });
  }

  return { middle, upper, lower };
}

/** The series (one, or three for Bollinger) an indicator draws. */
export function indicatorLines(spec: IndicatorSpec, candles: Candle[]): IndicatorLine[] {
  switch (spec.type) {
    case 'sma':
      return [{ key: spec.id, points: sma(candles, spec.period) }];
    case 'ema':
      return [{ key: spec.id, points: ema(candles, spec.period) }];
    case 'bb': {
      const { upper, middle, lower } = bollinger(candles, spec.period);
      return [
        { key: `${spec.id}:u`, points: upper },
        { key: `${spec.id}:m`, points: middle },
        { key: `${spec.id}:l`, points: lower },
      ];
    }
  }
}
