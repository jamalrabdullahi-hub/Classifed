import { describe, expect, it } from 'vitest';
import {
  Decimal,
  applyBps,
  differenceInBps,
  formatTokenAmount,
  formatUsd,
  fromBaseUnits,
  isBaseUnitString,
  subtractBps,
  toBaseUnits,
} from '../src/domain/money';
import { ValidationError } from '../src/domain/errors';

/**
 * Amount handling.
 *
 * These are the numbers a user makes a financial decision on, so the tests
 * cover the cases that would silently produce a wrong figure rather than an
 * obvious crash: precision beyond a token's decimals, values above 2^53, and
 * the boundary between "very small" and "zero".
 */

describe('base units', () => {
  it('round-trips through the human scale', () => {
    expect(toBaseUnits('1.5', 6)).toBe('1500000');
    expect(fromBaseUnits('1500000', 6)).toBe('1.5');
    expect(toBaseUnits('1', 18)).toBe('1000000000000000000');
    expect(fromBaseUnits('1000000000000000000', 18)).toBe('1');
  });

  it('handles amounts larger than a JS number can represent exactly', () => {
    // 2^53 + 1 in wei. A float would round this and quote the wrong trade.
    const huge = '9007199254740993000000000000';
    expect(isBaseUnitString(huge)).toBe(true);
    expect(fromBaseUnits(huge, 18)).toBe('9007199254.740993');
  });

  it('rejects more precision than the token can represent', () => {
    // Truncating silently would give the user a different trade than the one
    // they typed, so this must be an error rather than a rounding.
    expect(() => toBaseUnits('1.1234567', 6)).toThrow(ValidationError);
    expect(() => toBaseUnits('0.0000001', 6)).toThrow(ValidationError);
    expect(toBaseUnits('1.123456', 6)).toBe('1123456');
  });

  it('rejects anything that is not a positive decimal', () => {
    expect(() => toBaseUnits('-1', 18)).toThrow(ValidationError);
    expect(() => toBaseUnits('1e18', 18)).toThrow(ValidationError);
    expect(() => toBaseUnits('abc', 18)).toThrow(ValidationError);
    expect(() => toBaseUnits('', 18)).toThrow(ValidationError);
  });

  it('treats zero as valid base units but not as a valid amount to trade', () => {
    expect(isBaseUnitString('0')).toBe(true);
    expect(toBaseUnits('0', 18)).toBe('0');
  });
});

describe('basis points', () => {
  it('applies a rate, rounding down', () => {
    expect(applyBps('10000', 100)).toBe('100');
    expect(applyBps('1', 100)).toBe('0');
    // Rounding down means the user is never charged more than the stated rate.
    expect(applyBps('199', 100)).toBe('1');
  });

  it('subtracts a rate', () => {
    expect(subtractBps('10000', 50)).toBe('9950');
    expect(subtractBps('1000000000000000000', 50)).toBe('995000000000000000');
  });

  it('rejects a negative or fractional rate', () => {
    expect(() => applyBps('100', -1)).toThrow(ValidationError);
    expect(() => applyBps('100', 1.5)).toThrow(ValidationError);
  });
});

describe('price impact', () => {
  it('measures how far execution falls below the reference rate', () => {
    // 1% worse than reference.
    expect(differenceInBps(new Decimal(100), new Decimal(99))).toBe(100);
    expect(differenceInBps(new Decimal(100), new Decimal(95))).toBe(500);
    expect(differenceInBps(new Decimal(100), new Decimal(100))).toBe(0);
  });

  it('reports a better-than-reference rate as no impact', () => {
    // The reference is itself an estimate, so a negative impact would be
    // claiming a precision we do not have.
    expect(differenceInBps(new Decimal(100), new Decimal(101))).toBe(0);
  });

  it('returns zero rather than dividing by a zero reference', () => {
    expect(differenceInBps(new Decimal(0), new Decimal(5))).toBe(0);
  });
});

describe('formatting', () => {
  it('keeps both large balances and tiny prices readable', () => {
    expect(formatTokenAmount('1234567890', 6)).toBe('1234.56');
    expect(formatTokenAmount('1000000', 6)).toBe('1');
    // A very small holding must not collapse to "0".
    expect(formatTokenAmount('1', 18)).not.toBe('0');
  });

  it('renders zero as zero', () => {
    expect(formatTokenAmount('0', 18)).toBe('0');
  });

  it('distinguishes a sub-cent value from nothing', () => {
    // "$0.00" reads as worthless; "<$0.01" reads as very small, which is the
    // truth.
    expect(formatUsd('0.004')).toBe('<$0.01');
    expect(formatUsd('0')).toBe('$0.00');
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(undefined)).toBe('—');
  });

  it('groups thousands without touching the decimal part', () => {
    expect(formatUsd('1234.56')).toBe('$1,234.56');
    expect(formatUsd('1234567.89')).toBe('$1,234,567.89');
  });
});
