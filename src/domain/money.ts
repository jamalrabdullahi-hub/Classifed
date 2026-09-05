import Decimal from 'decimal.js';

// 60 significant digits gives plenty of headroom above the NUMERIC(38,18) the
// database stores, so intermediate arithmetic never silently loses precision.
// Rounding is always explicit at boundaries — never implicit mid-calculation.
Decimal.set({ precision: 60, toExpNeg: -40, toExpPos: 40 });

export { Decimal };

export type Numeric = Decimal | string | number;

/** Database storage limits: NUMERIC(38,18). */
export const DB_SCALE = 18;
export const DB_PRECISION = 38;

export const ROUND_DOWN = Decimal.ROUND_DOWN;
export const ROUND_UP = Decimal.ROUND_UP;
export const ROUND_HALF_UP = Decimal.ROUND_HALF_UP;

export class MoneyError extends Error {}

/**
 * Coerce to Decimal. Rejects the values that quietly poison money maths:
 * NaN, Infinity, and JS numbers that cannot represent the literal exactly.
 */
export function dec(value: Numeric): Decimal {
  if (value instanceof Decimal) {
    if (!value.isFinite()) throw new MoneyError(`Non-finite amount: ${value.toString()}`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MoneyError(`Non-finite amount: ${value}`);
    // A double cannot exactly hold most decimal fractions. Anything with a
    // fractional part must arrive as a string so no precision is lost upstream.
    if (!Number.isInteger(value)) {
      throw new MoneyError(
        `Refusing to build money from a fractional JS number (${value}). Pass a string.`,
      );
    }
    return new Decimal(value);
  }
  const trimmed = value.trim();
  if (trimmed === '') throw new MoneyError('Empty amount');
  let d: Decimal;
  try {
    d = new Decimal(trimmed);
  } catch {
    throw new MoneyError(`Not a valid decimal: ${value}`);
  }
  if (!d.isFinite()) throw new MoneyError(`Non-finite amount: ${value}`);
  return d;
}

/** Clamp to what the database column can actually hold, failing loudly if it cannot. */
export function toDbDecimal(value: Numeric): Decimal {
  const d = dec(value);
  if (d.decimalPlaces() > DB_SCALE) {
    throw new MoneyError(
      `Amount ${d.toString()} has ${d.decimalPlaces()} decimal places, exceeding the ${DB_SCALE} the ledger stores. Round explicitly first.`,
    );
  }
  if (d.abs().gte(new Decimal(10).pow(DB_PRECISION - DB_SCALE))) {
    throw new MoneyError(`Amount ${d.toString()} overflows NUMERIC(${DB_PRECISION},${DB_SCALE}).`);
  }
  return d;
}

export interface AssetScale {
  symbol: string;
  /** Scale used when settling and presenting amounts of this asset. */
  quoteScale: number;
}

/**
 * A currency-tagged amount. Arithmetic between different currencies throws,
 * which is the single most common source of silent accounting bugs.
 */
export class Money {
  readonly amount: Decimal;
  readonly currency: string;

  private constructor(amount: Decimal, currency: string) {
    this.amount = amount;
    this.currency = currency;
  }

  static of(value: Numeric, currency: string): Money {
    if (!currency) throw new MoneyError('Money requires a currency');
    return new Money(dec(value), currency.toUpperCase());
  }

  static zero(currency: string): Money {
    return Money.of(0, currency);
  }

  private assertSame(other: Money, op: string): void {
    if (this.currency !== other.currency) {
      throw new MoneyError(
        `Cannot ${op} ${this.currency} and ${other.currency}. Convert through a quote first.`,
      );
    }
  }

  plus(other: Money): Money {
    this.assertSame(other, 'add');
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  minus(other: Money): Money {
    this.assertSame(other, 'subtract');
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  /** Multiply by a dimensionless scalar (a rate, a ratio). */
  times(scalar: Numeric): Money {
    return new Money(this.amount.times(dec(scalar)), this.currency);
  }

  dividedBy(scalar: Numeric): Money {
    const d = dec(scalar);
    if (d.isZero()) throw new MoneyError('Division by zero');
    return new Money(this.amount.dividedBy(d), this.currency);
  }

  negated(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  round(scale: number, mode: Decimal.Rounding = ROUND_HALF_UP): Money {
    return new Money(this.amount.toDecimalPlaces(scale, mode), this.currency);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }
  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero();
  }
  isPositive(): boolean {
    return this.amount.isPositive() && !this.amount.isZero();
  }
  gt(other: Money): boolean {
    this.assertSame(other, 'compare');
    return this.amount.gt(other.amount);
  }
  gte(other: Money): boolean {
    this.assertSame(other, 'compare');
    return this.amount.gte(other.amount);
  }
  lt(other: Money): boolean {
    this.assertSame(other, 'compare');
    return this.amount.lt(other.amount);
  }
  lte(other: Money): boolean {
    this.assertSame(other, 'compare');
    return this.amount.lte(other.amount);
  }
  eq(other: Money): boolean {
    this.assertSame(other, 'compare');
    return this.amount.eq(other.amount);
  }

  toString(): string {
    return `${this.amount.toFixed()} ${this.currency}`;
  }

  toFixed(scale: number): string {
    return this.amount.toFixed(scale);
  }

  toDb(): Decimal {
    return toDbDecimal(this.amount);
  }
}

/** Basis points applied to an amount. 100 bps = 1%. */
export function applyBps(amount: Decimal, bps: number): Decimal {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new MoneyError(`Fee basis points must be a non-negative integer, got ${bps}`);
  }
  return amount.times(bps).dividedBy(10_000);
}

/**
 * Round a fee in the house's favour (up), and the customer's crypto in the
 * house's favour (down). Both by at most one minor unit of the asset. The
 * residual is never discarded — callers post it to the ROUNDING account so
 * the journal still balances exactly.
 */
export function roundFee(amount: Decimal, scale: number): Decimal {
  return amount.toDecimalPlaces(scale, ROUND_UP);
}

export function roundDeliverable(amount: Decimal, scale: number): Decimal {
  return amount.toDecimalPlaces(scale, ROUND_DOWN);
}

/**
 * Split `total` into `weights.length` parts proportional to the weights, at the
 * given scale, guaranteeing the parts sum to exactly `total`. Any rounding
 * remainder is distributed one minor unit at a time to the largest parts first.
 */
export function allocate(total: Decimal, weights: Decimal[], scale: number): Decimal[] {
  if (weights.length === 0) throw new MoneyError('allocate requires at least one weight');
  const weightSum = weights.reduce((a, b) => a.plus(b), new Decimal(0));
  if (weightSum.isZero()) throw new MoneyError('allocate requires a non-zero weight total');

  const unit = new Decimal(10).pow(-scale);
  const parts = weights.map((w) =>
    total.times(w).dividedBy(weightSum).toDecimalPlaces(scale, ROUND_DOWN),
  );
  let remainder = total.minus(parts.reduce((a, b) => a.plus(b), new Decimal(0)));

  const order = weights
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w.comparedTo(a.w))
    .map((x) => x.i);

  let cursor = 0;
  while (remainder.abs().gte(unit) && cursor < order.length * 1000) {
    const idx = order[cursor % order.length]!;
    if (remainder.isPositive()) {
      parts[idx] = parts[idx]!.plus(unit);
      remainder = remainder.minus(unit);
    } else {
      parts[idx] = parts[idx]!.minus(unit);
      remainder = remainder.plus(unit);
    }
    cursor += 1;
  }
  return parts;
}

/**
 * Collapse negative zero to positive zero.
 *
 * decimal.js preserves the sign of zero, so negating a zero liability balance
 * yields -0, and `-0 .isNegative()` is true. Left unchecked that makes an empty
 * account look overdrawn to any solvency or sufficiency check.
 */
export function normalizeZero(value: Decimal): Decimal {
  return value.isZero() ? new Decimal(0) : value;
}

export const USD = 'USD';
export const USD_SCALE = 2;

export function usd(value: Numeric): Money {
  return Money.of(value, USD);
}
