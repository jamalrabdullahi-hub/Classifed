import { z } from 'zod';
import { AlgorithmStrategy } from '@flt/db';
import { backtest } from '@flt/core/services/algorithm-backtest';
import { resolveOfferedMarket } from '@flt/core/services/perps';
import { perpVenues } from '@flt/providers';
import { NotFoundError } from '@flt/core/domain';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * The backtest calculator.
 *
 * Replays a deterministic strategy over up to 60 days of hourly candles at a
 * chosen leverage and account size, so a participant can see how leverage cuts
 * both ways before committing. An illustration, not a forecast — no fees,
 * funding or slippage, and the AI path cannot be replayed cheaply, so the AI
 * page runs this over a representative strategy and says so.
 */
const schema = z.object({
  symbol: z.string().trim().min(1).max(24),
  strategy: z.nativeEnum(AlgorithmStrategy),
  params: z.record(z.unknown()).optional(),
  leverage: z.coerce.number().int().min(1).max(100).default(1),
  accountSize: z.string().trim().regex(/^\d+(\.\d+)?$/).default('1000'),
  days: z.coerce.number().int().min(1).max(60).default(60),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.QUOTE, scope: 'algorithm-backtest' } },
  async ({ body }) => {
    const offered = await resolveOfferedMarket(perpVenues(), body.symbol);
    if (!offered) throw new NotFoundError('Market');
    const { venue, market } = offered;

    // ~24 hourly bars a day, plus a little warm-up for the moving averages.
    const bars = Math.min(1_500, (body.days ?? 60) * 24 + 60);
    const candles = await venue.getCandles(market.symbol, '1h', bars);

    return {
      symbol: market.symbol,
      days: body.days ?? 60,
      leverage: body.leverage ?? 1,
      result: backtest({
        strategy: body.strategy,
        params: (body.params ?? {}) as never,
        candles,
        leverage: body.leverage ?? 1,
        accountSize: body.accountSize ?? '1000',
      }),
    };
  },
);
