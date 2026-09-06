import { StateMachine } from '../domain/state';

/**
 * Protection policy lifecycle (§13).
 *
 * The states are the spec's, with the transitions constrained to the ones that
 * are actually meaningful:
 *
 * - **WARNING** is entered when the price has moved far enough that the policy
 *   is worth looking at, and is reversible — a position that recovers goes back
 *   to ACTIVE rather than being stuck in a state it can never leave.
 * - **REBALANCE_REQUIRED** is Omni's: the last rebase raised the requirement
 *   and it is not funded. It resolves back to ACTIVE when funded, or forward to
 *   POSITION_REDUCTION when it is not.
 * - **POSITION_REDUCTION** is Base Smooth's progressive state and Omni's
 *   unfunded-shortfall state. It can return to ACTIVE, because a participant
 *   who reduces enough is compliant again.
 * - **LIQUIDATED** is the venue's outcome, not ours, and is terminal. It can be
 *   reached from any live state because a venue liquidation is not something
 *   the policy gets to sequence.
 *
 * §13 requires an immutable audit event for **every** transition, carrying the
 * fourteen named fields. That is what {@link ProtectionTransitionRecord} is.
 * It must be written in the same transaction as the state change — not through
 * `audit()`, which runs outside any transaction, swallows its own write errors,
 * and would silently redact any field named `code`, `nonce` or `signature`.
 */

export type ProtectionState =
  | 'CREATED'
  | 'ACTIVE'
  | 'WARNING'
  | 'PROTECTION_ACTIVE'
  | 'REBALANCE_REQUIRED'
  | 'POSITION_REDUCTION'
  | 'LIQUIDATED'
  | 'EXPIRED'
  | 'CANCELLED';

const TERMINAL: readonly ProtectionState[] = ['LIQUIDATED', 'EXPIRED', 'CANCELLED'];

/** Every state a live policy can be liquidated or cancelled out of. */
const LIVE: readonly ProtectionState[] = [
  'ACTIVE',
  'WARNING',
  'PROTECTION_ACTIVE',
  'REBALANCE_REQUIRED',
  'POSITION_REDUCTION',
];

const endings: readonly ProtectionState[] = ['LIQUIDATED', 'EXPIRED', 'CANCELLED'];

export const protectionStateMachine = new StateMachine<ProtectionState>(
  'ProtectionPolicy',
  {
    CREATED: ['ACTIVE', 'CANCELLED'],
    ACTIVE: ['WARNING', 'PROTECTION_ACTIVE', 'REBALANCE_REQUIRED', ...endings],
    WARNING: ['ACTIVE', 'PROTECTION_ACTIVE', 'REBALANCE_REQUIRED', 'POSITION_REDUCTION', ...endings],
    PROTECTION_ACTIVE: ['ACTIVE', 'WARNING', 'POSITION_REDUCTION', ...endings],
    REBALANCE_REQUIRED: ['ACTIVE', 'WARNING', 'POSITION_REDUCTION', ...endings],
    POSITION_REDUCTION: ['ACTIVE', 'WARNING', 'PROTECTION_ACTIVE', ...endings],
    LIQUIDATED: [],
    EXPIRED: [],
    CANCELLED: [],
  },
  TERMINAL,
);

export { LIVE as LIVE_PROTECTION_STATES };

/**
 * The immutable record §13 demands, one per transition.
 *
 * Every field is a string rather than a number: these are decimal quantities
 * and a JS float would make the record irreproducible, which defeats its whole
 * purpose. `null` means genuinely unknown — the venue did not report it — and
 * is never a stand-in for zero.
 *
 * The reproducibility test for this shape: an auditor holding only one of these
 * rows, and the formulas in this module, must be able to recompute `boundary`
 * and `requiredContribution` and get the same digits back.
 */
export interface ProtectionTransitionRecord {
  occurredAt: Date;
  from: ProtectionState;
  to: ProtectionState;

  underlyingPrice: string;
  markPrice: string | null;
  volatility: string;
  volatilityModel: string;
  percentile: string;
  zScore: string;
  zConvention: string;
  horizonDays: string;
  boundary: string;
  requiredContribution: string;
  currentContribution: string;
  positionSize: string;
  notional: string;

  /** What the engine advised. Never what it did — it cannot do anything. */
  action: string;
  executionPrice: string | null;
  fee: string | null;
  remainingProtectionBalance: string | null;
}
