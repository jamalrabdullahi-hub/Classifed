/**
 * Shared shapes for the protection endpoints.
 *
 * Lives outside the route files because Next.js only permits its own exports
 * from a route module, and because the disclosure below must be identical
 * everywhere it appears — an integrator reading one endpoint's JSON and not
 * another's must not come away with a different idea of what a policy is.
 */

export const PROTECTION_DISCLOSURE = {
  contributionHeld: false,
  canActOnPosition: false,
  note:
    'A policy is a calculation and a declaration, not cover. FLT holds no contribution, no ' +
    'claim can be paid, and FLT cannot open, close or reduce your position — only the key in ' +
    'your browser can. Any reduction shown is a recommendation for you to act on.',
} as const;

interface PolicyRow {
  id: string;
  kind: string;
  state: string;
  side: string;
  entryPrice: string;
  referencePrice: string;
  notional: string;
  initialNotional: string;
  percentile: string;
  horizonDays: string;
  smoothStartAt: string | null;
  volatilityModel: string;
  volatilityInterval: string;
  volatilityWindow: number;
  lastZScore: string | null;
  lastVolatility: string | null;
  lastStatisticalMove: string | null;
  lastBoundary: string | null;
  lastRequiredContribution: string | null;
  declaredContribution: string;
  calculatedAt: Date | null;
  nextRebaseAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
}

/**
 * The terms are grouped and named rather than flattened, because §14 forbids
 * changing any of them silently — and the way to make that visible is to put
 * them somewhere a reader can check them against the event log, together.
 */
export function serialisePolicyRow(policy: PolicyRow) {
  return {
    id: policy.id,
    kind: policy.kind,
    state: policy.state,
    side: policy.side,
    entryPrice: policy.entryPrice,
    referencePrice: policy.referencePrice,
    notional: policy.notional,
    initialNotional: policy.initialNotional,
    terms: {
      percentile: policy.percentile,
      zConvention: 'one-tailed',
      horizonDays: policy.horizonDays,
      smoothStartAt: policy.smoothStartAt,
      volatilityModel: policy.volatilityModel,
      volatilityInterval: policy.volatilityInterval,
      volatilityWindow: policy.volatilityWindow,
    },
    lastCalculation: {
      zScore: policy.lastZScore,
      dailySigma: policy.lastVolatility,
      statisticalMove: policy.lastStatisticalMove,
      boundary: policy.lastBoundary,
      requiredContribution: policy.lastRequiredContribution,
      at: policy.calculatedAt,
    },
    /** What the participant says they hold. Not a balance FLT custodies. */
    declaredContribution: policy.declaredContribution,
    nextRebaseAt: policy.nextRebaseAt,
    closedAt: policy.closedAt,
    createdAt: policy.createdAt,
  };
}
