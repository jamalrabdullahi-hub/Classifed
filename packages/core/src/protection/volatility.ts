import { Decimal } from '../domain/money';
import { ValidationError } from '../domain/errors';
import type { Candle } from '../ports/history';

/**
 * Volatility estimation.
 *
 * §9 requires that the model be replaceable and that normality not be baked
 * into the architecture. So the interface comes first and the estimator is one
 * implementation of it. EWMA, realized volatility, GARCH and Student-t are
 * later implementations of exactly this shape; nothing downstream of
 * {@link VolatilityEstimate} knows which produced it.
 *
 * The distributional assumption lives in `zscore.ts` behind a named convention,
 * not scattered here — swapping to a Student-t tail is a change of z-source,
 * not a change of volatility model.
 *
 * σ is **per period of the candle interval**, and the estimate says which
 * period that is. Scaling to a horizon is `peril.ts`'s job and needs both
 * numbers; an estimate that did not carry its own period would make the
 * √T scaling silently wrong whenever the caller changed interval.
 */

export interface VolatilityEstimate {
  /** Standard deviation of log returns, per {@link periodDays}. */
  readonly sigma: Decimal;
  /** The length of one observation period, in days. */
  readonly periodDays: Decimal;
  /** How many returns the estimate is built from (candles − 1). */
  readonly observations: number;
  /** The model that produced it, carried for the audit record. */
  readonly model: string;
  /** Mean log return over the window. Reported, never used to centre σ — see below. */
  readonly meanLogReturn: Decimal;
}

export interface VolatilityModel {
  readonly name: string;
  /**
   * @param candles ascending by time, oldest first.
   * @param window  the most recent N candles to use. Fewer available is an error,
   *                not a silent shorter window — a σ computed from 12 bars when
   *                90 were requested is a different number wearing the same label.
   * @param periodDays length of one candle, in days (1/24 for hourly, 1 for daily).
   */
  calculate(candles: Candle[], window: number, periodDays: number): VolatilityEstimate;
}

/**
 * Sample standard deviation of log returns.
 *
 * Two choices worth stating, because both change the number:
 *
 * **Bessel's correction (n−1).** The window is a sample of a process, not the
 * population, and n−1 gives the larger σ. Erring toward more required
 * protection is the right direction for a fund that has to pay claims.
 *
 * **The mean is subtracted.** An asset that trended hard over the window has a
 * non-zero mean return; not removing it inflates σ with drift that is not
 * volatility. The mean is reported separately so an auditor can see exactly
 * what was removed.
 */
export class HistoricalStdDev implements VolatilityModel {
  readonly name = 'historical-stddev';

  calculate(candles: Candle[], window: number, periodDays: number): VolatilityEstimate {
    if (!Number.isInteger(window) || window < 3) {
      throw new ValidationError('Volatility window must be an integer of at least 3 candles', {
        window,
      });
    }
    if (!Number.isFinite(periodDays) || periodDays <= 0) {
      throw new ValidationError('Candle period must be a positive number of days', { periodDays });
    }
    if (candles.length < window) {
      throw new ValidationError(
        `Not enough price history: ${window} candles required, ${candles.length} available`,
        { window, available: candles.length },
      );
    }

    const recent = candles.slice(-window);

    const returns: Decimal[] = [];
    for (let i = 1; i < recent.length; i += 1) {
      const previous = new Decimal(recent[i - 1]!.close);
      const current = new Decimal(recent[i]!.close);
      if (previous.lessThanOrEqualTo(0) || current.lessThanOrEqualTo(0)) {
        throw new ValidationError('Price history contains a non-positive close', {
          time: recent[i]!.time,
        });
      }
      returns.push(current.dividedBy(previous).ln());
    }

    const n = new Decimal(returns.length);
    const mean = returns.reduce((sum, r) => sum.plus(r), new Decimal(0)).dividedBy(n);
    const sumSquares = returns.reduce(
      (sum, r) => sum.plus(r.minus(mean).pow(2)),
      new Decimal(0),
    );
    const variance = sumSquares.dividedBy(n.minus(1));

    return {
      sigma: variance.sqrt(),
      periodDays: new Decimal(periodDays),
      observations: returns.length,
      model: this.name,
      meanLogReturn: mean,
    };
  }
}

/** Days per candle, for the intervals the history ports speak. */
export const INTERVAL_DAYS: Record<string, number> = {
  '1m': 1 / 1440,
  '5m': 5 / 1440,
  '15m': 15 / 1440,
  '1h': 1 / 24,
  '4h': 4 / 24,
  '1d': 1,
};

/**
 * Rescales σ from its own period to per-day, so estimates from different
 * intervals are comparable. √t scaling, which assumes independent increments —
 * the same assumption the horizon scaling in `peril.ts` makes, and stated in
 * both places rather than hidden in one.
 */
export function toDailySigma(estimate: VolatilityEstimate): Decimal {
  return estimate.sigma.dividedBy(estimate.periodDays.sqrt());
}
