import { z } from 'zod';
import { AlgorithmStrategy, AlgorithmStrategyType } from '@flt/db';
import { backtest } from '@flt/core/services/algorithm-backtest';
import { compileExpression } from '@flt/core/services/strategy-dsl';
import { resolveOfferedMarket } from '@flt/core/services/perps';
import { perpVenues } from '@flt/providers';
import { NotFoundError, ValidationError } from '@flt/core/domain';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * The backtest calculator.
 *
 * Replays a strategy over up to 60 days of hourly candles at a chosen leverage
 * and account size. Accepts all three strategy types: a **built-in**, a
 * **composite** (a mix of built-ins), or a **custom** expression in the
 * restricted strategy language. An illustration, not a forecast — no fees,
 * funding or slippage.
 */
const memberSchema = z.object({
  strategy: z.nativeEnum(AlgorithmStrategy),
  params: z.record(z.unknown()).optional(),
  weight: z.coerce.number().min(0).max(100).optional(),
});
const compositionSchema = z.object({
  members: z.array(memberSchema).min(1).max(8),
  combine: z.enum(['MAJORITY', 'WEIGHTED']).optional(),
});

const schema = z.object({
  symbol: z.string().trim().min(1).max(24),
  strategyType: z.nativeEnum(AlgorithmStrategyType).default(AlgorithmStrategyType.BUILTIN),
  strategy: z.nativeEnum(AlgorithmStrategy).default(AlgorithmStrategy.MOMENTUM),
  params: z.record(z.unknown()).optional(),
  composition: compositionSchema.optional(),
  expression: z.string().trim().max(500).optional(),
  leverage: z.coerce.number().int().min(1).max(100).default(1),
  accountSize: z.string().trim().regex(/^\d+(\.\d+)?$/).default('1000'),
  days: z.coerce.number().int().min(1).max(60).default(60),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.QUOTE, scope: 'algorithm-backtest' } },
  async ({ body }) => {
    const strategyType = body.strategyType ?? AlgorithmStrategyType.BUILTIN;

    if (strategyType === AlgorithmStrategyType.CUSTOM && body.expression) {
      // Surface a syntax error here rather than at run time.
      compileExpression(body.expression);
    }
    if (strategyType === AlgorithmStrategyType.COMPOSITE && !body.composition) {
      throw new ValidationError('A composite strategy needs members');
    }

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
        strategyType,
        strategy: body.strategy ?? AlgorithmStrategy.MOMENTUM,
        params: (body.params ?? {}) as never,
        composition: (body.composition ?? null) as never,
        expression: body.expression ?? null,
        candles,
        leverage: body.leverage ?? 1,
        accountSize: body.accountSize ?? '1000',
      }),
    };
  },
);
