import { NotFoundError, ValidationError, Decimal } from '@flt/core/domain';
import { getOfferedMarket } from '@flt/core/services/perps';
import {
  calculateProtection,
  serialiseProtection,
  PROTECTION_DEFAULTS,
} from '@flt/core/services/protection';
import { isPerpCandleInterval, type PerpCandleInterval } from '@flt/core/ports';
import { perpVenue } from '@flt/providers';
import { routeHandler } from '@/server/api';

/**
 * The calculation endpoint (§15).
 *
 * Deliberately a pure function of its query string. It reads no account, holds
 * no state and returns nothing user-specific, so the same request always
 * produces the same answer for the same market conditions — which is exactly
 * what §14's "reproducible from logged inputs" needs. The panel passes the
 * user's own position figures in; the endpoint does not go looking for them.
 *
 * That also makes it the surface an auditor or a Shariah board can point at:
 * the response carries every input, every intermediate and every modifier, so
 * the boundary and the required contribution can be recomputed by hand from
 * the JSON with no access to this code.
 */
export const GET = routeHandler<unknown, { symbol: string }, unknown>(
  {},
  async ({ params, request }) => {
    const venue = perpVenue();

    const offered = await getOfferedMarket(venue, params.symbol);
    if (!offered) throw new NotFoundError('Market');

    const query = new URL(request.url).searchParams;

    const side = (query.get('side') ?? 'LONG').toUpperCase();
    if (side !== 'LONG' && side !== 'SHORT') {
      throw new ValidationError('Side must be LONG or SHORT', { side });
    }

    const interval = query.get('interval') ?? PROTECTION_DEFAULTS.interval;
    if (!isPerpCandleInterval(interval)) {
      throw new ValidationError('Unsupported interval', { interval });
    }

    const market = offered.market;
    if (!market.markPrice) {
      throw new ValidationError('The venue is not reporting a price for this market', {
        symbol: market.symbol,
      });
    }
    const mark = new Decimal(market.markPrice);

    const calculation = await calculateProtection(venue, {
      symbol: market.symbol,
      side,
      // An absent entry price means "price this as if opened now", which is
      // the case for a position that does not exist yet.
      entryPrice: decimal(query, 'entryPrice') ?? mark,
      notional: decimal(query, 'notional') ?? mark,
      liquidationPrice: decimal(query, 'liquidationPrice'),

      percentile: numeric(query, 'percentile', PROTECTION_DEFAULTS.percentile),
      horizonDays: decimal(query, 'horizonDays') ?? new Decimal(PROTECTION_DEFAULTS.horizonDays),
      smoothStartAt:
        decimal(query, 'smoothStartAt') ?? new Decimal(PROTECTION_DEFAULTS.smoothStartAt),

      interval: interval as PerpCandleInterval,
      window: Math.min(Math.max(numeric(query, 'window', PROTECTION_DEFAULTS.window), 20), 500),

      previousContribution: decimal(query, 'previousContribution') ?? undefined,
    });

    return serialiseProtection(calculation);
  },
);

/**
 * A decimal query parameter, or null when absent.
 *
 * Rejects anything unparseable rather than falling back to a default: a
 * mistyped notional silently becoming the mark price would produce a plausible
 * number that answers a different question than the one asked.
 */
function decimal(query: URLSearchParams, name: string): Decimal | null {
  const raw = query.get(name);
  if (raw === null || raw.trim() === '') return null;

  // decimal.js throws on unparseable input rather than returning a NaN, so the
  // check has to be a catch and not an isFinite test.
  try {
    const value = new Decimal(raw);
    if (!value.isFinite()) throw new Error('not finite');
    return value;
  } catch {
    throw new ValidationError(`${name} must be a finite decimal number`, { [name]: raw });
  }
}

function numeric(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ValidationError(`${name} must be a finite number`, { [name]: raw });
  }
  return value;
}
