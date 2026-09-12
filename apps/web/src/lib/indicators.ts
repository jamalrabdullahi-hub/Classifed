import type { Candle } from '@flt/core/ports';

/**
 * Chart indicators, computed on the client.
 *
 * A small catalog (each entry knows its label, which pane it draws in, and its
 * configurable parameters) plus the maths. Kept free of any `@flt/db` import so
 * the terminal — a client component — can pull it without dragging the Prisma
 * client into the browser bundle; the tier policy takes a plain tier string, not
 * the enum.
 *
 * Two kinds:
 *   - **overlay**   — draws on the price pane (moving averages, bands).
 *   - **oscillator**— draws in its own lower pane (RSI, MACD, …), because it is
 *     on a different scale and would squash the candles if overlaid.
 */

export type IndicatorType =
  | 'sma'
  | 'ema'
  | 'wma'
  | 'bb'
  | 'donchian'
  | 'rsi'
  | 'macd'
  | 'stoch'
  | 'atr';

export type IndicatorPane = 'overlay' | 'oscillator';

export interface IndicatorParam {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step?: number;
}

export interface IndicatorDefinition {
  label: string;
  pane: IndicatorPane;
  params: IndicatorParam[];
}

const LENGTH = (def = 20): IndicatorParam => ({ key: 'period', label: 'Len', default: def, min: 2, max: 400 });

export const INDICATOR_TYPES: Record<IndicatorType, IndicatorDefinition> = {
  sma: { label: 'SMA', pane: 'overlay', params: [LENGTH()] },
  ema: { label: 'EMA', pane: 'overlay', params: [LENGTH()] },
  wma: { label: 'WMA', pane: 'overlay', params: [LENGTH()] },
  bb: {
    label: 'Bollinger',
    pane: 'overlay',
    params: [LENGTH(), { key: 'stdDev', label: 'Dev', default: 2, min: 0.5, max: 6, step: 0.5 }],
  },
  donchian: { label: 'Donchian', pane: 'overlay', params: [LENGTH()] },
  rsi: { label: 'RSI', pane: 'oscillator', params: [LENGTH(14)] },
  macd: {
    label: 'MACD',
    pane: 'oscillator',
    params: [
      { key: 'fast', label: 'Fast', default: 12, min: 2, max: 100 },
      { key: 'slow', label: 'Slow', default: 26, min: 3, max: 200 },
      { key: 'signal', label: 'Sig', default: 9, min: 2, max: 100 },
    ],
  },
  stoch: {
    label: 'Stoch',
    pane: 'oscillator',
    params: [
      { key: 'kPeriod', label: '%K', default: 14, min: 1, max: 100 },
      { key: 'dPeriod', label: '%D', default: 3, min: 1, max: 100 },
    ],
  },
  atr: { label: 'ATR', pane: 'oscillator', params: [LENGTH(14)] },
};

const ALL_TYPES = Object.keys(INDICATOR_TYPES) as IndicatorType[];

export interface IndicatorSpec {
  /** Stable id, so a series is updated rather than recreated. */
  id: string;
  type: IndicatorType;
  params: Record<string, number>;
}

export interface IndicatorPoint {
  time: number; // seconds, matching the candle time
  value: number;
}

export interface IndicatorLine {
  /** Unique across all indicators on one chart, e.g. `<id>:u` for a BB band. */
  key: string;
  points: IndicatorPoint[];
  dashed?: boolean;
}

/** The default parameter set for an indicator type. */
export function defaultParams(type: IndicatorType): Record<string, number> {
  const out: Record<string, number> = {};
  for (const param of INDICATOR_TYPES[type].params) out[param.key] = param.default;
  return out;
}

/**
 * What a tier may add to a chart.
 *
 * FREE gets a single simple moving average — enough to read a trend, not the
 * toolkit. BASIC gets everything, three at a time. PRO and ELITE get ten.
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

// ── Moving averages over a value series ─────────────────────────────────────

/** Simple moving average over a {time,value} series. */
export function smaOf(points: IndicatorPoint[], period: number): IndicatorPoint[] {
  if (period < 1 || points.length < period) return [];
  const out: IndicatorPoint[] = [];
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    sum += points[i]!.value;
    if (i >= period) sum -= points[i - period]!.value;
    if (i >= period - 1) out.push({ time: points[i]!.time, value: sum / period });
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first window. */
export function emaOf(points: IndicatorPoint[], period: number): IndicatorPoint[] {
  if (period < 1 || points.length < period) return [];
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i += 1) prev += points[i]!.value;
  prev /= period;

  const out: IndicatorPoint[] = [{ time: points[period - 1]!.time, value: prev }];
  for (let i = period; i < points.length; i += 1) {
    prev = points[i]!.value * k + prev * (1 - k);
    out.push({ time: points[i]!.time, value: prev });
  }
  return out;
}

/** Weighted moving average — recent values weigh more, linearly. */
export function wmaOf(points: IndicatorPoint[], period: number): IndicatorPoint[] {
  if (period < 1 || points.length < period) return [];
  const denom = (period * (period + 1)) / 2;
  const out: IndicatorPoint[] = [];
  for (let i = period - 1; i < points.length; i += 1) {
    let sum = 0;
    for (let j = 0; j < period; j += 1) sum += points[i - j]!.value * (period - j);
    out.push({ time: points[i]!.time, value: sum / denom });
  }
  return out;
}

function closes(candles: Candle[]): IndicatorPoint[] {
  return candles.map((candle) => ({ time: candle.time, value: candle.close }));
}

export function sma(candles: Candle[], period: number): IndicatorPoint[] {
  return smaOf(closes(candles), period);
}
export function ema(candles: Candle[], period: number): IndicatorPoint[] {
  return emaOf(closes(candles), period);
}
export function wma(candles: Candle[], period: number): IndicatorPoint[] {
  return wmaOf(closes(candles), period);
}

/** Bollinger bands: a moving average with ±`mult` population standard deviations. */
export function bollinger(
  candles: Candle[],
  period: number,
  mult: number,
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

/** Donchian channels: the highest high and lowest low over the window. */
export function donchian(
  candles: Candle[],
  period: number,
): { upper: IndicatorPoint[]; lower: IndicatorPoint[] } {
  const upper: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];
  for (let i = period - 1; i < candles.length; i += 1) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      hi = Math.max(hi, candles[j]!.high);
      lo = Math.min(lo, candles[j]!.low);
    }
    upper.push({ time: candles[i]!.time, value: hi });
    lower.push({ time: candles[i]!.time, value: lo });
  }
  return { upper, lower };
}

/** Relative strength index (Wilder smoothing). */
export function rsi(candles: Candle[], period: number): IndicatorPoint[] {
  if (period < 1 || candles.length <= period) return [];

  const out: IndicatorPoint[] = [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;

  const value = () => (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  out.push({ time: candles[period]!.time, value: value() });

  for (let i = period + 1; i < candles.length; i += 1) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
    out.push({ time: candles[i]!.time, value: value() });
  }
  return out;
}

/** Moving average convergence/divergence. */
export function macd(
  candles: Candle[],
  fast: number,
  slow: number,
  signalPeriod: number,
): { macd: IndicatorPoint[]; signal: IndicatorPoint[]; hist: IndicatorPoint[] } {
  const series = closes(candles);
  const fastByTime = new Map(emaOf(series, fast).map((point) => [point.time, point.value]));

  const macdLine: IndicatorPoint[] = [];
  for (const point of emaOf(series, slow)) {
    const fastValue = fastByTime.get(point.time);
    if (fastValue === undefined) continue;
    macdLine.push({ time: point.time, value: fastValue - point.value });
  }

  const signal = emaOf(macdLine, signalPeriod);
  const signalByTime = new Map(signal.map((point) => [point.time, point.value]));
  const hist = macdLine
    .filter((point) => signalByTime.has(point.time))
    .map((point) => ({ time: point.time, value: point.value - signalByTime.get(point.time)! }));

  return { macd: macdLine, signal, hist };
}

/** Stochastic oscillator (%K and its %D smoothing). */
export function stochastic(
  candles: Candle[],
  kPeriod: number,
  dPeriod: number,
): { k: IndicatorPoint[]; d: IndicatorPoint[] } {
  const k: IndicatorPoint[] = [];
  for (let i = kPeriod - 1; i < candles.length; i += 1) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j += 1) {
      hi = Math.max(hi, candles[j]!.high);
      lo = Math.min(lo, candles[j]!.low);
    }
    const range = hi - lo;
    k.push({ time: candles[i]!.time, value: range === 0 ? 50 : ((candles[i]!.close - lo) / range) * 100 });
  }
  return { k, d: smaOf(k, dPeriod) };
}

/** Average true range (Wilder smoothing). */
export function atr(candles: Candle[], period: number): IndicatorPoint[] {
  if (candles.length <= period) return [];

  const trueRange: IndicatorPoint[] = candles.map((candle, i) => {
    const prev = candles[i - 1];
    const tr = prev
      ? Math.max(candle.high - candle.low, Math.abs(candle.high - prev.close), Math.abs(candle.low - prev.close))
      : candle.high - candle.low;
    return { time: candle.time, value: tr };
  });

  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += trueRange[i]!.value;
  let prev = sum / period;

  const out: IndicatorPoint[] = [{ time: trueRange[period - 1]!.time, value: prev }];
  for (let i = period; i < trueRange.length; i += 1) {
    prev = (prev * (period - 1) + trueRange[i]!.value) / period;
    out.push({ time: trueRange[i]!.time, value: prev });
  }
  return out;
}

/** The series (one, or several for a banded indicator) an indicator draws. */
export function indicatorLines(spec: IndicatorSpec, candles: Candle[]): IndicatorLine[] {
  const def = INDICATOR_TYPES[spec.type];
  const p = (key: string): number =>
    spec.params[key] ?? def.params.find((param) => param.key === key)?.default ?? 0;

  switch (spec.type) {
    case 'sma':
      return [{ key: spec.id, points: sma(candles, p('period')) }];
    case 'ema':
      return [{ key: spec.id, points: ema(candles, p('period')) }];
    case 'wma':
      return [{ key: spec.id, points: wma(candles, p('period')) }];
    case 'bb': {
      const { upper, middle, lower } = bollinger(candles, p('period'), p('stdDev'));
      return [
        { key: `${spec.id}:u`, points: upper, dashed: true },
        { key: `${spec.id}:m`, points: middle },
        { key: `${spec.id}:l`, points: lower, dashed: true },
      ];
    }
    case 'donchian': {
      const { upper, lower } = donchian(candles, p('period'));
      return [
        { key: `${spec.id}:u`, points: upper, dashed: true },
        { key: `${spec.id}:l`, points: lower, dashed: true },
      ];
    }
    case 'rsi':
      return [{ key: spec.id, points: rsi(candles, p('period')) }];
    case 'macd': {
      const bands = macd(candles, p('fast'), p('slow'), p('signal'));
      return [
        { key: `${spec.id}:m`, points: bands.macd },
        { key: `${spec.id}:s`, points: bands.signal, dashed: true },
      ];
    }
    case 'stoch': {
      const st = stochastic(candles, p('kPeriod'), p('dPeriod'));
      return [
        { key: `${spec.id}:k`, points: st.k },
        { key: `${spec.id}:d`, points: st.d, dashed: true },
      ];
    }
    case 'atr':
      return [{ key: spec.id, points: atr(candles, p('period')) }];
  }
}
