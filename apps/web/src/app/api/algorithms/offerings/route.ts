import { z } from 'zod';
import { AlgorithmStrategy, AlgorithmStrategyType } from '@flt/db';
import { createOfferingFromBacktest } from '@flt/core/services/algorithms';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * "Push to algo": create an offering from a backtested configuration.
 *
 * It starts PRIVATE — only the creator can activate it — and publishing is a
 * separate, deliberate step.
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
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(400).optional(),
  symbols: z.array(z.string().trim().min(1).max(24)).min(1).max(10),
  maxLeverage: z.coerce.number().int().min(1).max(100),
  maxNotionalUsd: z.string().trim().regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal'),
  strategyType: z.nativeEnum(AlgorithmStrategyType),
  strategy: z.nativeEnum(AlgorithmStrategy).optional(),
  params: z.record(z.unknown()).optional(),
  composition: compositionSchema.optional(),
  expression: z.string().trim().max(500).optional(),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.QUOTE, scope: 'algorithm-create' } },
  async ({ body, user }) => {
    const row = await createOfferingFromBacktest(user, {
      name: body.name,
      description: body.description,
      symbols: body.symbols,
      maxLeverage: body.maxLeverage,
      maxNotionalUsd: body.maxNotionalUsd,
      strategyType: body.strategyType,
      strategy: body.strategy,
      params: body.params,
      composition: (body.composition ?? null) as never,
      expression: body.expression ?? null,
    });

    return { slug: row.slug, name: row.name, visibility: row.visibility };
  },
);
