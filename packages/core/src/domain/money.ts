import { Decimal as DecimalJs } from 'decimal.js';
import { formatUnits, parseUnits } from 'viem';
import { ValidationError } from './errors';

/**
 * Amount handling.
 *
 * Two distinct kinds of number live in this system and must never be confused:
 *
 *   1. **Base units** — an integer count of a token's smallest unit (wei, satoshi,
 *      the 6-decimal unit of USDC). These can exceed 2^53 and are carried as
 *      `bigint` in memory and decimal STRINGS across every boundary: the API,
 *      the database, the provider adapters. Never a JS number.
 *
 *   2. **Display and valuation** — human-scaled quantities and USD estimates.
 *      These use Decimal, which is exact for the arithmetic we do.
 *
 * Converting between them requires the token's decimals, which is why nearly
 * every helper here takes it explicitly. A conversion that guesses is a bug.
 */

DecimalJs.set({ precision: 40, rounding: DecimalJs.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 40 });

export const Decimal = DecimalJs;
export type Decimal = DecimalJs;

/** A non-negative integer in base units. */
const BASE_UNIT_PATTERN = /^\d+$/;

export function isBaseUnitString(value: string): boolean {
  return BASE_UNIT_PATTERN.test(value);
}

export function assertBaseUnits(value: string, field = 'amount'): string {
  if (!isBaseUnitString(value)) {
    throw new ValidationError(`${field} must be a non-negative integer in base units`, { value });
  }
  return value;
}

export function toBigInt(value: string, field = 'amount'): bigint {
  return BigInt(assertBaseUnits(value, field));
}

/**
 * Base units to a human-scaled decimal string. `1000000` USDC (6dp) -> `"1"`.
 * Exact: no rounding happens here.
 */
export function fromBaseUnits(value: string | bigint, decimals: number): string {
  const raw = typeof value === 'bigint' ? value : toBigInt(value);
  return formatUnits(raw, decimals);
}

/**
 * Human-scaled decimal string to base units. `"1.5"` at 6dp -> `"1500000"`.
 *
 * Rejects more precision than the token can represent rather than silently
 * truncating it — a user who types more decimals than exist should be told,
 * not quietly given a different trade.
 */
export function toBaseUnits(value: string, decimals: number): string {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new ValidationError('Amount must be a positive decimal number', { value });
  }

  const fraction = trimmed.split('.')[1] ?? '';
  if (fraction.length > decimals) {
    throw new ValidationError(
      `This token supports at most ${decimals} decimal places`,
      { value, decimals },
    );
  }

  return parseUnits(trimmed, decimals).toString();
}

/** Human-scaled Decimal, for valuation arithmetic. */
export function toDecimal(value: string | bigint, decimals: number): Decimal {
  return new DecimalJs(fromBaseUnits(value, decimals));
}

// ── Basis points ────────────────────────────────────────────────────────────

export const BPS_DENOMINATOR = 10_000n;

/** Applies a basis-point rate to a base-unit amount, rounding down. */
export function applyBps(amount: string | bigint, bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new ValidationError('Basis points must be a non-negative integer', { bps });
  }
  const raw = typeof amount === 'bigint' ? amount : toBigInt(amount);
  return ((raw * BigInt(bps)) / BPS_DENOMINATOR).toString();
}

/** Subtracts a basis-point rate from a base-unit amount, rounding down. */
export function subtractBps(amount: string | bigint, bps: number): string {
  const raw = typeof amount === 'bigint' ? amount : toBigInt(amount);
  return (raw - BigInt(applyBps(raw, bps))).toString();
}

/**
 * The proportional difference between two rates, in basis points.
 *
 * Used for price impact: `reference` is the rate at negligible size, `actual`
 * is the rate this trade would get. A positive result means the trade executes
 * worse than the reference. Clamped at zero — a better-than-reference rate is
 * reported as no impact rather than as a negative one, because the reference
 * is itself an estimate.
 */
export function differenceInBps(reference: Decimal, actual: Decimal): number {
  if (reference.isZero() || reference.isNegative()) return 0;
  const delta = reference.minus(actual).dividedBy(reference).times(10_000);
  if (delta.isNegative()) return 0;
  return Math.round(delta.toNumber());
}

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Significant-figure formatting for token quantities.
 *
 * A price of 0.0000000234 and a balance of 12,043.19 both need to be readable,
 * so precision is chosen relative to magnitude rather than fixed.
 */
export function formatTokenAmount(
  value: string | bigint,
  decimals: number,
  options: { maxSignificant?: number } = {},
): string {
  const amount = toDecimal(value, decimals);
  if (amount.isZero()) return '0';

  const maxSignificant = options.maxSignificant ?? 6;
  const abs = amount.abs();

  if (abs.greaterThanOrEqualTo(1)) {
    const formatted = amount.toDecimalPlaces(
      abs.greaterThanOrEqualTo(1000) ? 2 : 4,
      DecimalJs.ROUND_DOWN,
    );
    return stripTrailingZeros(formatted.toFixed());
  }

  return stripTrailingZeros(amount.toSignificantDigits(maxSignificant, DecimalJs.ROUND_DOWN).toFixed());
}

/** USD estimates. Always an estimate — never presented as settled accounting. */
export function formatUsd(value: Decimal | string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const amount = new DecimalJs(value.toString());
  if (!amount.isFinite()) return '—';

  const abs = amount.abs();
  // Sub-cent values would all render as $0.00, which reads as "worthless"
  // rather than "very small".
  if (!abs.isZero() && abs.lessThan(0.01)) return '<$0.01';

  return `$${amount.toDecimalPlaces(2, DecimalJs.ROUND_HALF_UP).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function stripTrailingZeros(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/\.?0+$/, '');
}
