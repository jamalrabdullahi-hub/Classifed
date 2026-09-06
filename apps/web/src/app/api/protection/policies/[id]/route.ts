import { getPolicy, cancelPolicy, policyBalances } from '@flt/core/services/protection-policies';
import { assertPerpsEnabled } from '@flt/core/services/perps';
import { routeHandler } from '@/server/api';
import { PROTECTION_DISCLOSURE, serialisePolicyRow } from '@/server/protection';

/**
 * One policy: its terms, its full transition history, and its ledger.
 *
 * §15 lists `/protection/:id` and `/protection/:id/audit` separately. They are
 * one response here because the audit trail is not supplementary material — it
 * is the thing that makes the policy checkable, and an endpoint that returns a
 * policy without it invites reading the current figures and trusting them.
 *
 * The ledger's balances come back split by kind and never summed across
 * participant capital and operator revenue, which is §19's central rule.
 */
export const GET = routeHandler<unknown, { id: string }, unknown>(
  {},
  async ({ params, user }) => {
    assertPerpsEnabled();

    const { policy, events, ledger } = await getPolicy(params.id, user!);
    const balances = await policyBalances(params.id);

    return {
      policy: serialisePolicyRow(policy),

      /**
       * Every transition, newest first, with the inputs that caused it. §13's
       * fourteen fields plus the z convention, all as decimal strings: an
       * auditor holding one row and the formulas can recompute its boundary
       * and required contribution and get the same digits.
       */
      events: events.map((event) => ({
        id: event.id,
        from: event.fromState,
        to: event.toState,
        occurredAt: event.occurredAt,
        underlyingPrice: event.underlyingPrice,
        markPrice: event.markPrice,
        volatility: event.volatility,
        volatilityModel: event.volatilityModel,
        percentile: event.percentile,
        zScore: event.zScore,
        zConvention: event.zConvention,
        horizonDays: event.horizonDays,
        boundary: event.boundary,
        requiredContribution: event.requiredContribution,
        currentContribution: event.currentContribution,
        positionSize: event.positionSize,
        notional: event.notional,
        action: event.action,
        // Null throughout, and honestly so: FLT executes nothing, so there is
        // no fill price and no fee. Zero here would assert there had been.
        executionPrice: event.executionPrice,
        fee: event.fee,
        remainingProtectionBalance: event.remainingProtectionBalance,
      })),

      ledger: {
        entries: ledger.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          amount: entry.amount,
          balanceAfter: entry.balanceAfter,
          reason: entry.reason,
          occurredAt: entry.occurredAt,
        })),
        ...balances,
      },

      disclosure: PROTECTION_DISCLOSURE,
    };
  },
);

/** Ends the policy. The position is untouched — FLT cannot touch it. */
export const DELETE = routeHandler<unknown, { id: string }, unknown>(
  {},
  async ({ params, user }) => {
    assertPerpsEnabled();
    const policy = await cancelPolicy(params.id, user!);
    return {
      policy: serialisePolicyRow(policy),
      note: 'The policy has ended. Your position is unchanged — cancelling a policy does not close anything.',
    };
  },
);
