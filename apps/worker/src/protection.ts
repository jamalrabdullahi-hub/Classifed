import { ProtectionState, prisma } from '@flt/db';
import { env } from '@flt/config';
import { refreshPolicy } from '@flt/core/services/protection-policies';
import { perpVenue } from '@flt/providers';

/**
 * Protection policy sweep.
 *
 * Two jobs, both purely observational — which is the whole point.
 *
 * **Recalculation.** A policy whose state depends on live prices is wrong the
 * moment prices move. Recalculating on a schedule means the state a
 * participant sees was computed from recent prices rather than from whenever
 * they last opened the page, and each change writes its own immutable event.
 *
 * **Rebasing.** Omni's reference price moves only at a rebase (§5), so
 * something has to notice the interval has elapsed. Doing it here rather than
 * on page load means a participant who never logs in still gets an accurate
 * record — and, more importantly, that the rebase happens when it was due
 * rather than when they happened to look.
 *
 * What this pass cannot do, and must never be extended to do: act on a
 * position. §7 describes automatic reduction when a shortfall cannot be
 * funded. There is no key on this server capable of closing a position — the
 * agent key lives in the participant's browser — so the sweep records the
 * recommendation and stops. If that ever changes, it changes the product's
 * central promise, and would need an ADR before a line of code.
 */

export interface ProtectionSweepResult {
  considered: number;
  recalculated: number;
  rebased: number;
  transitioned: number;
  ended: number;
  failures: number;
}

/**
 * How stale a live policy is allowed to get.
 *
 * Well short of the shortest rebase interval, so a state change caused by
 * price is noticed long before the rebase that would have caught it anyway.
 */
const STALE_AFTER_MS = 10 * 60_000;

const LIVE: ProtectionState[] = [
  ProtectionState.ACTIVE,
  ProtectionState.WARNING,
  ProtectionState.PROTECTION_ACTIVE,
  ProtectionState.REBALANCE_REQUIRED,
  ProtectionState.POSITION_REDUCTION,
];

export async function sweepProtectionPolicies(): Promise<ProtectionSweepResult> {
  const result: ProtectionSweepResult = {
    considered: 0,
    recalculated: 0,
    rebased: 0,
    transitioned: 0,
    ended: 0,
    failures: 0,
  };

  if (!env().PERPS_ENABLED) return result;

  const now = new Date();

  const due = await prisma.protectionPolicy.findMany({
    where: {
      state: { in: LIVE },
      OR: [
        { nextRebaseAt: { lte: now } },
        { calculatedAt: null },
        { calculatedAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
      ],
    },
    // Oldest calculation first, so a backlog drains fairly rather than
    // starving whichever policies sort last.
    orderBy: { calculatedAt: { sort: 'asc', nulls: 'first' } },
    take: 200,
  });

  result.considered = due.length;
  if (due.length === 0) return result;

  const venue = perpVenue();

  for (const policy of due) {
    try {
      const rebasing = policy.nextRebaseAt !== null && policy.nextRebaseAt <= now;
      const refreshed = await refreshPolicy(venue, policy.id, { forceRebase: rebasing });

      result.recalculated += 1;
      if (refreshed.settlement) result.rebased += 1;
      if (refreshed.transitionedTo) result.transitioned += 1;
      if (refreshed.policy.closedAt) result.ended += 1;
    } catch (error) {
      // One policy failing must not stop the sweep. The venue rate-limits and
      // a single participant's position can vanish mid-pass; neither is a
      // reason to leave every other policy stale.
      result.failures += 1;
      console.error('[protection] policy refresh failed', {
        policyId: policy.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
