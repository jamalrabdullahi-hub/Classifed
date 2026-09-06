import { refreshPolicy } from '@flt/core/services/protection-policies';
import { getPolicy } from '@flt/core/services/protection-policies';
import { assertPerpsEnabled } from '@flt/core/services/perps';
import { perpVenue } from '@flt/providers';
import { routeHandler } from '@/server/api';
import { PROTECTION_DISCLOSURE, serialisePolicyRow } from '@/server/protection';

/**
 * Recalculates the policy against live prices, rebasing if it is Omni.
 *
 * A rebase moves Omni's reference to the current price and settles the
 * difference in required contribution (§7). The Base policies are recalculated
 * but never rebased: §3 is explicit that a $100 → $95 → $85 path keeps $100 as
 * the reference, and honouring that is what separates them from Omni.
 *
 * Settling is bookkeeping, not a transfer. A release means the participant is
 * no longer committed to that capital; nothing is sent to them, because FLT
 * never held it.
 */
export const POST = routeHandler<unknown, { id: string }, unknown>(
  {},
  async ({ params, user }) => {
    assertPerpsEnabled();

    // Ownership is checked here so a POST cannot recalculate a stranger's
    // policy and, through the response, reveal their position size.
    await getPolicy(params.id, user!);

    const result = await refreshPolicy(perpVenue(), params.id, { forceRebase: true });

    return {
      policy: serialisePolicyRow(result.policy),
      transitionedTo: result.transitionedTo,
      settlement: result.settlement
        ? {
            ...result.settlement,
            note:
              result.settlement.kind === 'release'
                ? 'The requirement fell. You are no longer committed to this much capital — nothing is transferred, because FLT never held it.'
                : 'The requirement rose. Declare more capital, or reduce the position.',
          }
        : null,
      warnings: result.assessment?.warnings ?? [],
      disclosure: PROTECTION_DISCLOSURE,
    };
  },
);
