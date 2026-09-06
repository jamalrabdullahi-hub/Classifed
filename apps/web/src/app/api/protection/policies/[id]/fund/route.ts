import { z } from 'zod';
import { Decimal } from '@flt/core/domain';
import { declareFunding } from '@flt/core/services/protection-policies';
import { assertPerpsEnabled } from '@flt/core/services/perps';
import { routeHandler } from '@/server/api';
import { PROTECTION_DISCLOSURE, serialisePolicyRow } from '@/server/protection';

/**
 * Declares capital held against the policy.
 *
 * §15 calls this `/fund`, which in a custodial system would move money. It
 * does not here, and the naming is the one place that could mislead — so the
 * response says plainly what happened. FLT holds no participant funds; this
 * records a figure the participant states they have set aside, which the
 * engine then compares against the requirement.
 *
 * Declaring more than the requirement is allowed. Declaring less is allowed
 * too — that is what puts an Omni policy into REBALANCE_REQUIRED, which is
 * information the participant needs rather than an error.
 */
const schema = z.object({
  /** The total held against this policy, not a delta. */
  declaredAmount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'Must be a non-negative decimal number'),
  reason: z.string().trim().max(280).optional(),
});

export const POST = routeHandler<z.infer<typeof schema>, { id: string }, unknown>(
  { schema },
  async ({ params, user, body }) => {
    assertPerpsEnabled();

    const policy = await declareFunding(
      params.id,
      user!,
      new Decimal(body.declaredAmount),
      body.reason,
    );

    const required = new Decimal(policy.lastRequiredContribution ?? 0);
    const declared = new Decimal(policy.declaredContribution);

    return {
      policy: serialisePolicyRow(policy),
      shortfall: declared.lessThan(required) ? required.minus(declared).toFixed() : '0',
      surplus: declared.greaterThan(required) ? declared.minus(required).toFixed() : '0',
      note:
        'Recorded as a declaration. No funds were transferred and FLT holds nothing on your ' +
        'behalf — this is the figure the engine compares against the required contribution.',
      disclosure: PROTECTION_DISCLOSURE,
    };
  },
);
