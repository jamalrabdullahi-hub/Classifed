import { z } from 'zod';
import { ProtectionPolicyKind } from '@flt/db';
import { resolveTradingWallet } from '@flt/core/services/wallets';
import { assertPerpsEnabled } from '@flt/core/services/perps';
import { createPolicy, listPolicies } from '@flt/core/services/protection-policies';
import { RateLimits } from '@flt/core/services/ratelimit';
import { isPerpCandleInterval } from '@flt/core/ports';
import { prisma } from '@flt/db';
import { perpVenue } from '@flt/providers';
import { handler } from '@/server/api';
import { PROTECTION_DISCLOSURE, serialisePolicyRow } from '@/server/protection';

/**
 * Writing and listing protection policies.
 *
 * §15 specifies three creation endpoints — one per policy. They are one
 * endpoint with a `kind` here because the three differ only in which fields
 * apply, and three routes duplicating the same authorisation, position lookup
 * and volatility estimation would be three places for those to drift apart.
 * The distinction the spec cares about is preserved where it matters: the
 * stored terms, the calculation, and the state machine.
 *
 * A policy is a record of a calculation and a commitment the participant has
 * declared. It moves no money — FLT holds none — and it grants FLT no ability
 * to act on the position.
 */
const schema = z.object({
  kind: z.nativeEnum(ProtectionPolicyKind),
  symbol: z.string().trim().min(1).max(24),
  /** One-tailed. 0.9973 means a 99.73% chance the boundary is not breached. */
  percentile: z.coerce.number().gt(0.5).lt(1).optional(),
  /** Omni's rebasing interval. Ignored for the Base policies, which are 1 day. */
  horizonDays: z.coerce.number().int().min(1).max(365).optional(),
  /** Base Smooth only: the adverse excursion at which intervention begins. */
  smoothStartAt: z
    .string()
    .regex(/^0(\.\d+)?$/, 'Must be a fraction between 0 and 1')
    .optional(),
  interval: z.string().refine(isPerpCandleInterval, 'Unsupported interval').optional(),
  window: z.coerce.number().int().min(20).max(500).optional(),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.QUOTE, scope: 'protection-policy' } },
  async ({ user, body }) => {
    assertPerpsEnabled();

    const venue = perpVenue();
    const wallet = await resolveTradingWallet(prisma, user.id);

    const { policy, assessment } = await createPolicy(
      venue,
      { user, wallet },
      {
        kind: body.kind,
        symbol: body.symbol,
        percentile: body.percentile,
        horizonDays: body.horizonDays,
        smoothStartAt: body.smoothStartAt,
        interval: body.interval as never,
        window: body.window,
      },
    );

    return {
      policy: serialisePolicyRow(policy),
      boundary: assessment.peril.boundary.toFixed(),
      requiredContribution: assessment.contribution.requiredContribution.toFixed(),
      warnings: assessment.warnings,
      disclosure: PROTECTION_DISCLOSURE,
    };
  },
);

export const GET = handler({}, async ({ user }) => {
  assertPerpsEnabled();

  const policies = await listPolicies(user.id);

  return {
    policies: policies.map((policy) => ({
      ...serialisePolicyRow(policy),
      symbol: policy.market.symbol,
      marketName: policy.market.name,
    })),
    disclosure: PROTECTION_DISCLOSURE,
  };
});
