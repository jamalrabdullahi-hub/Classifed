import { describe, expect, it } from 'vitest';
import { compileExpression, evaluateExpression } from '../src/services/strategy-dsl';
import type { Candle } from '../src/ports/history';

function candles(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: index * 3_600,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}

const rising = (n: number) => Array.from({ length: n }, (_, i) => 100 + i);

describe('strategy DSL — evaluation', () => {
  it('reads momentum as fast-minus-slow', () => {
    expect(evaluateExpression('sma(12) - sma(48)', candles(rising(60)))!).toBeGreaterThan(0);
  });

  it('reads mean reversion as average-minus-price', () => {
    const series = candles([...Array.from({ length: 30 }, () => 100), 80]);
    expect(evaluateExpression('sma(20) - close', series)!).toBeGreaterThan(0);
  });

  it('yields 1 for a true comparison', () => {
    expect(evaluateExpression('close > sma(10)', candles(rising(30)))).toBe(1);
  });

  it('respects arithmetic precedence', () => {
    expect(evaluateExpression('1 + 2 * 3', candles([1, 2]))).toBe(7);
  });

  it('returns null when there is not enough history', () => {
    expect(evaluateExpression('sma(50) - close', candles([1, 2, 3]))).toBeNull();
  });

  it('returns the raw value (zero) for a flat signal', () => {
    expect(evaluateExpression('close - close', candles(rising(10)))).toBe(0);
  });
});

describe('strategy DSL — safety', () => {
  it('rejects unknown functions', () => {
    expect(() => compileExpression('evil(5)')).toThrow();
  });

  it('rejects unknown names', () => {
    expect(() => compileExpression('process')).toThrow();
  });

  it('rejects stray characters', () => {
    expect(() => compileExpression('close; process')).toThrow();
  });

  it('rejects an empty expression', () => {
    expect(() => compileExpression('   ')).toThrow();
  });
});
