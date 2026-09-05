import { describe, expect, it } from 'vitest';
import {
  Decimal,
  Money,
  MoneyError,
  allocate,
  applyBps,
  dec,
  normalizeZero,
  roundDeliverable,
  roundFee,
  toDbDecimal,
} from '../../src/domain/money';

describe('money', () => {
  describe('dec', () => {
    it('accepts decimal strings without losing precision', () => {
      expect(dec('0.1').plus(dec('0.2')).toString()).toBe('0.3');
      expect(dec('123456789.123456789012345678').toString()).toBe(
        '123456789.123456789012345678',
      );
    });

    it('refuses a fractional JS number, which cannot represent the literal exactly', () => {
      expect(() => dec(0.1)).toThrow(MoneyError);
    });

    it('accepts integer JS numbers', () => {
      expect(dec(100).toString()).toBe('100');
    });

    it('refuses NaN, Infinity and gibberish', () => {
      expect(() => dec(Number.NaN)).toThrow(MoneyError);
      expect(() => dec(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
      expect(() => dec('abc')).toThrow(MoneyError);
      expect(() => dec('')).toThrow(MoneyError);
    });
  });

  describe('toDbDecimal', () => {
    it('accepts exactly 18 decimal places', () => {
      expect(toDbDecimal('0.000000000000000001').toString()).toBe('0.000000000000000001');
    });

    it('refuses 19 decimal places rather than silently truncating', () => {
      expect(() => toDbDecimal('0.0000000000000000001')).toThrow(/decimal places/);
    });

    it('refuses values that overflow the column', () => {
      expect(() => toDbDecimal('1' + '0'.repeat(20))).toThrow(/overflow/);
    });
  });

  describe('Money', () => {
    it('refuses arithmetic across currencies', () => {
      const usd = Money.of('100', 'USD');
      const btc = Money.of('1', 'BTC');
      expect(() => usd.plus(btc)).toThrow(/Cannot add USD and BTC/);
      expect(() => usd.minus(btc)).toThrow(MoneyError);
      expect(() => usd.gt(btc)).toThrow(MoneyError);
    });

    it('adds and subtracts within a currency', () => {
      const a = Money.of('100.55', 'USD');
      const b = Money.of('0.45', 'USD');
      expect(a.plus(b).toFixed(2)).toBe('101.00');
      expect(a.minus(b).toFixed(2)).toBe('100.10');
    });

    it('does not treat a zero balance as negative', () => {
      expect(Money.of('0', 'USD').negated().isNegative()).toBe(false);
      expect(Money.of('0', 'USD').isPositive()).toBe(false);
      expect(Money.of('0', 'USD').isZero()).toBe(true);
    });

    it('refuses division by zero', () => {
      expect(() => Money.of('100', 'USD').dividedBy(0)).toThrow(MoneyError);
    });
  });

  describe('normalizeZero', () => {
    it('collapses negative zero, which decimal.js reports as negative', () => {
      const negZero = new Decimal(0).negated();
      expect(negZero.isNegative()).toBe(true);
      expect(normalizeZero(negZero).isNegative()).toBe(false);
    });

    it('leaves genuine values alone', () => {
      expect(normalizeZero(new Decimal('-5')).toString()).toBe('-5');
      expect(normalizeZero(new Decimal('5')).toString()).toBe('5');
    });
  });

  describe('fees', () => {
    it('applies basis points exactly', () => {
      expect(applyBps(new Decimal('100'), 100).toString()).toBe('1');
      expect(applyBps(new Decimal('100'), 50).toString()).toBe('0.5');
      expect(applyBps(new Decimal('0.01'), 100).toString()).toBe('0.0001');
    });

    it('refuses negative or fractional basis points', () => {
      expect(() => applyBps(new Decimal('100'), -1)).toThrow(MoneyError);
      expect(() => applyBps(new Decimal('100'), 1.5)).toThrow(MoneyError);
    });

    it('rounds fees up and deliverables down, always in the house favour', () => {
      // A fee of 0.011 becomes 0.02; a deliverable of 0.019 becomes 0.01.
      expect(roundFee(new Decimal('0.011'), 2).toString()).toBe('0.02');
      expect(roundDeliverable(new Decimal('0.019'), 2).toString()).toBe('0.01');
    });

    it('never rounds a fee down to zero on a tiny amount', () => {
      const fee = roundFee(applyBps(new Decimal('0.01'), 100), 2);
      expect(fee.toString()).toBe('0.01');
    });
  });

  describe('allocate', () => {
    it('splits without losing a cent', () => {
      const parts = allocate(new Decimal('100'), [new Decimal(1), new Decimal(1), new Decimal(1)], 2);
      const sum = parts.reduce((a, b) => a.plus(b), new Decimal(0));
      expect(sum.toString()).toBe('100');
      expect(parts.map((p) => p.toString()).sort()).toEqual(['33.33', '33.33', '33.34'].sort());
    });

    it('respects weights', () => {
      const parts = allocate(new Decimal('100'), [new Decimal(3), new Decimal(1)], 2);
      expect(parts[0]!.toString()).toBe('75');
      expect(parts[1]!.toString()).toBe('25');
    });

    it('handles a single recipient', () => {
      const parts = allocate(new Decimal('0.07'), [new Decimal(1)], 2);
      expect(parts[0]!.toString()).toBe('0.07');
    });

    it('refuses a zero weight total', () => {
      expect(() => allocate(new Decimal('100'), [new Decimal(0)], 2)).toThrow(MoneyError);
    });
  });
});
