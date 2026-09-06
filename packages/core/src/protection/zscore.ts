import { Decimal } from '../domain/money';
import { ValidationError } from '../domain/errors';

/**
 * Percentile → z-score: the inverse standard-normal CDF.
 *
 * ## The tail convention, stated once
 *
 * The build specification's table mixes two conventions. 90 / 95 / 99 / 99.9 /
 * 99.99% are one-tailed quantiles and match Φ⁻¹ exactly. But 68.27% → 1.000 and
 * 99.73% → 3.000 are *two-tailed* σ-multiples — the familiar 1σ/3σ figures,
 * which are the probability of staying inside a symmetric band.
 *
 * A protection boundary is one-sided. It sits below the reference for a long
 * and above it for a short; the upside is not a peril. So C is read as **the
 * probability that the price does not breach the boundary in one direction**,
 * and therefore:
 *
 *     z = Φ⁻¹(C)
 *
 * At 99.73% that is **2.7822, not 3.000** — a 7.8% difference in z, and so in
 * every boundary and contribution downstream. The spec's own headline example
 * (§3: $100 entry, 3% daily σ, 99.73%) becomes **$91.99**, not $91.39.
 *
 * This is a deliberate substitution, documented here as §6 requires. Anyone
 * reproducing a figure must know which convention produced it, which is why
 * {@link Z_CONVENTION} is carried through the API response rather than left
 * implicit in the code.
 *
 * ## Why a float
 *
 * Acklam's rational approximation is accurate to ~1.15e-9 relative, and z is a
 * dimensionless constant. The volatility it multiplies is an *estimate* from a
 * few hundred candles, with error orders of magnitude larger. Carrying z as a
 * float and converting immediately to `Decimal` is a stated choice, not an
 * oversight: refining it further would add no information the inputs contain.
 *
 * Settlement amounts downstream are pure `Decimal`, per §14.
 */

export const Z_CONVENTION = 'one-tailed' as const;
export type ZConvention = typeof Z_CONVENTION;

/** Acklam's coefficients. */
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
];
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
];
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

const P_LOW = 0.02425;
const P_HIGH = 1 - P_LOW;

/**
 * Φ⁻¹(p) for p in (0, 1), as a float.
 *
 * Exported for testing the approximation directly. Callers wanting a z-score
 * should use {@link zScoreForPercentile}, which validates the percentile and
 * returns a `Decimal`.
 */
export function inverseNormalCdf(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new ValidationError('Percentile must be strictly between 0 and 1', { p });
  }

  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1)
    );
  }

  if (p > P_HIGH) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1)
    );
  }

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q) /
    (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1)
  );
}

/**
 * The protection percentile, as a fraction in (0.5, 1).
 *
 * Below 0.5 the "boundary" would sit above the reference price for a long,
 * which is not a peril boundary at all — it is refused rather than quietly
 * producing a negative z. 0.5 exactly gives z = 0 and a boundary at the
 * reference, which is equally meaningless.
 */
export function zScoreForPercentile(percentile: number): Decimal {
  if (!Number.isFinite(percentile) || percentile <= 0.5 || percentile >= 1) {
    throw new ValidationError(
      'Protection percentile must be strictly between 0.5 and 1 (e.g. 0.9973)',
      { percentile },
    );
  }
  return new Decimal(inverseNormalCdf(percentile));
}
