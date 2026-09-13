import {
  ProtectionLedgerKind,
  ProtectionPolicyKind as PolicyKindEnum,
  ProtectionState as StateEnum,
  type DbClient,
  type ProtectionPolicy,
  type User,
  type Wallet,
  prisma,
} from '@flt/db';
import { env } from '@flt/config';
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { protectionStateMachine, type ProtectionState } from '../protection/state';
import type { PolicyAssessment } from '../protection/policies';
import { requiredReduction } from '../protection/contribution';
import { assertMayTrade } from './kyc';
import { AuditAction, audit } from './audit';
import {
  calculateProtection,
  PROTECTION_DEFAULTS,
  type ProtectionCalculation,
} from './protection';
import type { PerpVenue } from '../ports/perps';
import type { PerpCandleInterval } from '../ports/perps';

/**
 * Policy lifecycle.
 *
 * ## What this does and does not do
 *
 * It records: which policy a participant chose, on what terms, what the engine
 * calculated at each point, every state transition with the inputs that caused
 * it, and a ledger that keeps participant capital and operator revenue apart.
 *
 * It does not hold money and it does not act on positions. `declareFunding`
 * records a figure the participant states they hold against the policy; no
 * transfer occurs and FLT custodies nothing. `recommendReduction` computes a
 * reduction and writes it down; the participant places the trade with the key
 * in their browser, which is the only key that can.
 *
 * That is not a stage left unfinished. There is no server-side key capable of
 * closing a position, so automatic execution is impossible by construction —
 * and a policy that claimed otherwise would be the most dangerous lie the
 * system could tell.
 *
 * ## Why transitions are not routed through `audit()`
 *
 * §13 requires an immutable event for *every* transition. `audit()` runs
 * outside any transaction and swallows its own write errors, so a transition
 * could commit with no record of it; it also redacts fields by name, which
 * would gut a settlement payload. Every transition here writes its event row
 * inside the same transaction as the state change. `audit()` is still called
 * alongside, for the human-facing trail.
 */

// ── Creation ────────────────────────────────────────────────────────────────

export interface CreatePolicyInput {
  kind: PolicyKindEnum;
  symbol: string;
  percentile?: number;
  horizonDays?: number;
  smoothStartAt?: string;
  interval?: PerpCandleInterval;
  window?: number;
}

export interface PolicyContext {
  user: User;
  wallet: Wallet;
}

/**
 * Writes a policy against a position the participant actually holds.
 *
 * A policy over a position that does not exist would have no entry price to
 * anchor to and no liquidation price to measure against, so this refuses
 * rather than inventing a hypothetical. Pricing a hypothetical is what the
 * calculation endpoint is for.
 */
export async function createPolicy(
  venue: PerpVenue,
  context: PolicyContext,
  input: CreatePolicyInput,
): Promise<{ policy: ProtectionPolicy; assessment: PolicyAssessment }> {
  assertMayTrade(context.user);

  const symbol = input.symbol.toUpperCase();

  const market = await prisma.perpMarket.findUnique({
    where: { venueSlug_symbol: { venueSlug: venue.meta.slug, symbol } },
  });
  if (!market || !market.isEnabled) throw new NotFoundError('Market');

  const existing = await prisma.protectionPolicy.findFirst({
    where: {
      walletId: context.wallet.id,
      marketId: market.id,
      state: { notIn: [StateEnum.LIQUIDATED, StateEnum.EXPIRED, StateEnum.CANCELLED] },
    },
  });
  if (existing) {
    throw new ValidationError(
      'This position already has an open protection policy. Cancel it before writing another — ' +
        'two policies over one position would each compute a requirement as though it were the ' +
        'only one.',
      { policyId: existing.id },
    );
  }

  /**
   * Where the position actually is.
   *
   * Under custody every position is opened on the **omnibus's** venue account,
   * not on the participant's own wallet — so reading the participant's address
   * finds nothing and a policy can never be written, which is precisely how
   * insurance came to be unbuyable. The participant's wallet is still the right
   * address when custody is off and they hold the position themselves.
   */
  const positionAddress =
    env().CUSTODY_PROVIDER === 'privy' && env().OMNIBUS_EVM_ADDRESS
      ? env().OMNIBUS_EVM_ADDRESS!
      : context.wallet.address;

  const positions = await venue.getPositions({ address: positionAddress });
  const position = positions.find((candidate) => candidate.symbol === symbol);
  if (!position) {
    throw new ValidationError(
      `You have no open ${symbol} position to protect. A policy is anchored to a real entry ` +
        'price and measured against the venue\'s liquidation price; neither exists yet.',
      { symbol },
    );
  }

  const terms = resolveTerms(input);
  const notionalUsd = await currentNotional(venue, symbol, position);

  const calculation = await calculateProtection(venue, {
    symbol,
    side: position.side,
    entryPrice: new Decimal(position.entryPrice),
    notional: notionalUsd,
    liquidationPrice: position.liquidationPrice ? new Decimal(position.liquidationPrice) : null,
    percentile: terms.percentile,
    horizonDays: new Decimal(terms.horizonDays),
    smoothStartAt: new Decimal(terms.smoothStartAt),
    interval: terms.interval,
    window: terms.window,
  });

  const assessment = calculation.policies[kindToPolicy(input.kind)];

  const policy = await prisma.$transaction(async (tx) => {
    const created = await tx.protectionPolicy.create({
      data: {
        id: newId(),
        userId: context.user.id,
        walletId: context.wallet.id,
        marketId: market.id,
        venueSlug: venue.meta.slug,
        kind: input.kind,
        state: StateEnum.CREATED,
        side: position.side,
        entryPrice: position.entryPrice,
        // Base policies anchor to entry forever; Omni starts there and rebases.
        referencePrice: assessment.referencePrice.toFixed(),
        notional: notionalUsd.toFixed(),
        initialNotional: notionalUsd.toFixed(),
        percentile: String(terms.percentile),
        horizonDays: String(assessment.peril.horizonDays),
        smoothStartAt: input.kind === PolicyKindEnum.BASE_SMOOTH ? terms.smoothStartAt : null,
        volatilityModel: calculation.volatility.model,
        volatilityInterval: terms.interval,
        volatilityWindow: terms.window,
        ...calculatedFields(assessment, calculation),
        nextRebaseAt:
          input.kind === PolicyKindEnum.OMNI
            ? new Date(Date.now() + terms.horizonDays * 86_400_000)
            : null,
      },
    });

    // CREATED is a real state with a real record, so the terms a policy was
    // written on are in the event log from the first row rather than only in
    // the mutable policy row.
    await recordTransition(tx, created, StateEnum.CREATED, StateEnum.ACTIVE, {
      assessment,
      calculation,
      position,
      action: 'Policy written. Terms fixed at creation.',
    });

    return tx.protectionPolicy.update({
      where: { id: created.id },
      data: { state: StateEnum.ACTIVE },
    });
  });

  await audit(prisma, {
    action: AuditAction.PROTECTION_POLICY_CREATED,
    actorType: 'USER',
    actorUserId: context.user.id,
    entityType: 'protection_policy',
    entityId: policy.id,
    after: {
      kind: input.kind,
      symbol,
      percentile: terms.percentile,
      horizonDays: terms.horizonDays,
      boundary: assessment.peril.boundary.toFixed(),
      requiredContribution: assessment.contribution.requiredContribution.toFixed(),
    },
  });

  return { policy, assessment };
}

// ── Recalculation and rebasing ──────────────────────────────────────────────

export interface RefreshResult {
  policy: ProtectionPolicy;
  assessment: PolicyAssessment;
  calculation: ProtectionCalculation;
  /** Set when the requirement moved and Omni rebased. */
  settlement: { kind: 'release' | 'additional' | 'unchanged'; amount: string } | null;
  transitionedTo: ProtectionState | null;
}

/**
 * Recomputes a policy against live prices, moving its state if the position
 * has deteriorated, and rebasing Omni when its interval has elapsed.
 *
 * Base Day and Base Smooth never rebase: their reference is the entry price,
 * and §3 is explicit that a $100 → $95 → $85 path keeps $100. Only Omni's
 * reference moves, and only at a rebase — not on every recalculation, or the
 * boundary would chase the price continuously and never be reachable.
 */
export async function refreshPolicy(
  venue: PerpVenue,
  policyId: string,
  options: { forceRebase?: boolean; actorUserId?: string } = {},
): Promise<RefreshResult> {
  const policy = await prisma.protectionPolicy.findUnique({
    where: { id: policyId },
    include: { market: true, wallet: true },
  });
  if (!policy) throw new NotFoundError('Protection policy');

  if (protectionStateMachine.isTerminal(policy.state as ProtectionState)) {
    throw new ValidationError('This policy has ended and cannot be recalculated', {
      state: policy.state,
    });
  }

  const positions = await venue.getPositions({ address: policy.wallet.address });
  const position = positions.find((candidate) => candidate.symbol === policy.market.symbol);

  // The position is gone. The venue does not say why, so neither do we.
  if (!position) {
    const closed = await closePolicy(
      policy,
      StateEnum.EXPIRED,
      'The position is no longer open at the venue. Cause not observed.',
    );
    return {
      policy: closed,
      assessment: null as never,
      calculation: null as never,
      settlement: null,
      transitionedTo: 'EXPIRED',
    };
  }

  const rebasing =
    policy.kind === PolicyKindEnum.OMNI &&
    (options.forceRebase || (policy.nextRebaseAt !== null && policy.nextRebaseAt <= new Date()));

  const notionalUsd = await currentNotional(venue, policy.market.symbol, position);

  const calculation = await calculateProtection(venue, {
    symbol: policy.market.symbol,
    side: position.side,
    entryPrice: new Decimal(policy.entryPrice),
    notional: notionalUsd,
    liquidationPrice: position.liquidationPrice ? new Decimal(position.liquidationPrice) : null,
    percentile: Number(policy.percentile),
    horizonDays: new Decimal(policy.horizonDays),
    smoothStartAt: new Decimal(policy.smoothStartAt ?? PROTECTION_DEFAULTS.smoothStartAt),
    interval: policy.volatilityInterval as PerpCandleInterval,
    window: policy.volatilityWindow,
    previousContribution: policy.lastRequiredContribution
      ? new Decimal(policy.lastRequiredContribution)
      : undefined,
  });

  let assessment = calculation.policies[kindToPolicy(policy.kind)];

  // Between rebases Omni's boundary stays where the last rebase put it. The
  // live calculation above anchors to the current price, which is only correct
  // *at* a rebase — using it every time would slide the boundary under the
  // participant without any recorded event.
  if (policy.kind === PolicyKindEnum.OMNI && !rebasing) {
    assessment = {
      ...assessment,
      referencePrice: new Decimal(policy.referencePrice),
    };
  }

  const next = nextState(policy.state as ProtectionState, assessment, policy);
  const settlement = assessment.settlement
    ? { kind: assessment.settlement.kind, amount: assessment.settlement.amount.toFixed() }
    : null;

  const updated = await prisma.$transaction(async (tx) => {
    if (next !== policy.state) {
      await recordTransition(tx, policy, policy.state as ProtectionState, next, {
        assessment,
        calculation,
        position,
        action: transitionReason(next, assessment),
      });
    }

    // A rebase that releases or requires capital is a ledger event even when
    // no money moves, because the participant's obligation changed and §19
    // requires that be visible without replaying the calculation.
    if (rebasing && assessment.settlement && assessment.settlement.kind !== 'unchanged') {
      await appendLedger(tx, policy.id, {
        kind:
          assessment.settlement.kind === 'release'
            ? ProtectionLedgerKind.RELEASE
            : ProtectionLedgerKind.CONTRIBUTION,
        amount:
          assessment.settlement.kind === 'release'
            ? assessment.settlement.amount.negated().toFixed()
            : assessment.settlement.amount.toFixed(),
        reason:
          assessment.settlement.kind === 'release'
            ? 'Rebase lowered the requirement; the excess is no longer committed.'
            : 'Rebase raised the requirement.',
      });
    }

    return tx.protectionPolicy.update({
      where: { id: policy.id },
      data: {
        state: next,
        notional: notionalUsd.toFixed(),
        ...(rebasing
          ? {
              referencePrice: assessment.referencePrice.toFixed(),
              nextRebaseAt: new Date(
                Date.now() + Number(policy.horizonDays) * 86_400_000,
              ),
            }
          : {}),
        ...calculatedFields(assessment, calculation),
      },
    });
  });

  return {
    policy: updated,
    assessment,
    calculation,
    settlement: rebasing ? settlement : null,
    transitionedTo: next === policy.state ? null : next,
  };
}

// ── Participant actions ─────────────────────────────────────────────────────

/**
 * Records what the participant states they hold against the policy.
 *
 * **No money moves.** FLT does not custody participant funds, so this writes a
 * declared figure and a ledger entry, and nothing else. The wording is chosen
 * carefully everywhere it surfaces: the participant is telling us what they
 * have set aside, not sending it to us.
 */
export async function declareFunding(
  policyId: string,
  actor: User,
  amount: Decimal,
  reason = 'Participant declared capital held against this policy.',
): Promise<ProtectionPolicy> {
  if (!amount.isFinite() || amount.isNegative()) {
    throw new ValidationError('Declared amount must be a non-negative number', {
      amount: amount.toString(),
    });
  }

  const policy = await requireOwnPolicy(policyId, actor);

  if (protectionStateMachine.isTerminal(policy.state as ProtectionState)) {
    throw new ValidationError('This policy has ended', { state: policy.state });
  }

  return prisma.$transaction(async (tx) => {
    await appendLedger(tx, policy.id, {
      kind: ProtectionLedgerKind.CONTRIBUTION,
      amount: amount.minus(policy.declaredContribution).toFixed(),
      reason,
    });

    const required = new Decimal(policy.lastRequiredContribution ?? 0);
    const funded = amount.greaterThanOrEqualTo(required);

    // Funding a shortfall resolves REBALANCE_REQUIRED; it cannot lift a state
    // caused by price, which is why only that one transition is attempted.
    if (policy.state === StateEnum.REBALANCE_REQUIRED && funded) {
      await recordTransition(tx, policy, StateEnum.REBALANCE_REQUIRED, StateEnum.ACTIVE, {
        action: 'Shortfall covered by the participant\'s declared capital.',
        currentContribution: amount.toFixed(),
      });
    }

    return tx.protectionPolicy.update({
      where: { id: policy.id },
      data: {
        declaredContribution: amount.toFixed(),
        ...(policy.state === StateEnum.REBALANCE_REQUIRED && funded
          ? { state: StateEnum.ACTIVE }
          : {}),
      },
    });
  });
}

export interface ReductionAdvice {
  policyId: string;
  /** The largest notional the declared capital supports. */
  maxNotional: string;
  /** How much notional to close. Zero when the policy is already compliant. */
  reduction: string;
  reductionFraction: string;
  /** Contracts to close, at the current mark. */
  approximateSize: string;
  note: string;
}

/**
 * Computes the minimum reduction that restores compliance, and records it.
 *
 * Advice, recorded as advice. The policy moves to POSITION_REDUCTION so the
 * recommendation is in the event log with the inputs that produced it, but
 * nothing is executed — the participant closes the position themselves, with
 * the browser key that is the only thing able to.
 */
export async function recommendReduction(
  venue: PerpVenue,
  policyId: string,
  actor: User,
): Promise<ReductionAdvice> {
  // Ownership first: refreshing someone else's policy would touch their data.
  await requireOwnPolicy(policyId, actor);
  const { assessment, calculation, policy: refreshed } = await refreshPolicy(venue, policyId);

  if (!assessment) {
    throw new ValidationError('The position is no longer open', { policyId });
  }

  const advice = requiredReduction(
    assessment.contribution,
    new Decimal(refreshed.declaredContribution),
  );

  const size = advice.reduction.dividedBy(calculation.currentPrice);

  if (advice.reduction.isPositive() && refreshed.state !== StateEnum.POSITION_REDUCTION) {
    await prisma.$transaction(async (tx) => {
      await recordTransition(
        tx,
        refreshed,
        refreshed.state as ProtectionState,
        StateEnum.POSITION_REDUCTION,
        {
          assessment,
          calculation,
          action:
            `Reduce ${advice.reduction.toFixed(2)} of notional to restore compliance. ` +
            'Recommendation only — FLT cannot place this trade.',
        },
      );
      await tx.protectionPolicy.update({
        where: { id: refreshed.id },
        data: { state: StateEnum.POSITION_REDUCTION },
      });
    });
  }

  return {
    policyId,
    maxNotional: advice.maxNotional.toFixed(),
    reduction: advice.reduction.toFixed(),
    reductionFraction: advice.reductionFraction.toFixed(),
    approximateSize: size.toFixed(),
    note:
      'FLT cannot open, close or reduce your position — only the key in your browser can. ' +
      'Place this trade yourself if you want the policy to become compliant again.',
  };
}

export async function cancelPolicy(policyId: string, actor: User): Promise<ProtectionPolicy> {
  const policy = await requireOwnPolicy(policyId, actor);

  if (protectionStateMachine.isTerminal(policy.state as ProtectionState)) {
    return policy;
  }

  return closePolicy(policy, StateEnum.CANCELLED, 'Cancelled by the participant.');
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getPolicy(policyId: string, actor: User) {
  const policy = await requireOwnPolicy(policyId, actor);
  const [events, ledger] = await Promise.all([
    prisma.protectionEvent.findMany({
      where: { policyId },
      orderBy: { occurredAt: 'desc' },
      take: 100,
    }),
    prisma.protectionLedgerEntry.findMany({
      where: { policyId },
      orderBy: { occurredAt: 'desc' },
      take: 100,
    }),
  ]);

  return { policy, events, ledger };
}

export async function listPolicies(userId: string) {
  return prisma.protectionPolicy.findMany({
    where: { userId },
    include: { market: { select: { symbol: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Balances by kind, never netted.
 *
 * §19's central rule is that participant protection funds and operator revenue
 * are not mixed. Returning them as separate named balances rather than a single
 * total makes mixing them a thing a caller has to do deliberately.
 */
export async function policyBalances(policyId: string) {
  const entries = await prisma.protectionLedgerEntry.findMany({
    where: { policyId },
    orderBy: { occurredAt: 'asc' },
  });

  const balances: Record<string, Decimal> = {};
  for (const entry of entries) {
    balances[entry.kind] = (balances[entry.kind] ?? new Decimal(0)).plus(entry.amount);
  }

  const participant = [
    ProtectionLedgerKind.CONTRIBUTION,
    ProtectionLedgerKind.RELEASE,
    ProtectionLedgerKind.UTILIZATION,
  ].reduce((sum, kind) => sum.plus(balances[kind] ?? 0), new Decimal(0));

  return {
    byKind: Object.fromEntries(
      Object.entries(balances).map(([kind, value]) => [kind, value.toFixed()]),
    ),
    /** What the participant has committed, net of releases and utilization. */
    participantBalance: participant.toFixed(),
    /** Operator revenue. Deliberately a separate figure, never added above. */
    operatorFees: (balances[ProtectionLedgerKind.OPERATOR_FEE] ?? new Decimal(0)).toFixed(),
    custodied: false,
  };
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Protected notional: size × the **current** mark, not size × entry.
 *
 * §1 says "N = current protected notional", and the word matters. A position
 * of 10 contracts opened at $100 is worth $1,200 once the price reaches $120,
 * and pricing protection on the $1,000 it cost would under-provision it by
 * 17% — the exposure being protected is what the position is worth now, not
 * what it was bought for.
 *
 * It also makes Omni's rebase settle something. Anchoring notional to entry
 * would leave K identical at every rebase (D and N both unchanged), which
 * would make §7's release-and-top-up machinery dead code that never fired.
 *
 * Falls back to entry when the venue is not quoting: a stale notional beats
 * refusing to calculate, and the calculation itself will refuse a moment later
 * if the mark is genuinely unavailable.
 */
async function currentNotional(
  venue: PerpVenue,
  symbol: string,
  position: { size: string; entryPrice: string },
): Promise<Decimal> {
  const market = await venue.getMarket(symbol);
  const price = market?.markPrice ?? position.entryPrice;
  return new Decimal(position.size).times(price);
}

function resolveTerms(input: CreatePolicyInput) {
  const percentile = input.percentile ?? PROTECTION_DEFAULTS.percentile;
  if (!Number.isFinite(percentile) || percentile <= 0.5 || percentile >= 1) {
    throw new ValidationError('Protection percentile must be between 0.5 and 1', { percentile });
  }

  const horizonDays =
    input.kind === PolicyKindEnum.OMNI ? (input.horizonDays ?? PROTECTION_DEFAULTS.horizonDays) : 1;
  if (!Number.isFinite(horizonDays) || horizonDays <= 0 || horizonDays > 365) {
    throw new ValidationError('Horizon must be between 1 and 365 days', { horizonDays });
  }

  const window = input.window ?? PROTECTION_DEFAULTS.window;
  if (!Number.isInteger(window) || window < 20 || window > 500) {
    throw new ValidationError('Volatility window must be between 20 and 500 candles', { window });
  }

  return {
    percentile,
    horizonDays,
    smoothStartAt: input.smoothStartAt ?? PROTECTION_DEFAULTS.smoothStartAt,
    interval: input.interval ?? PROTECTION_DEFAULTS.interval,
    window,
  };
}

function kindToPolicy(kind: PolicyKindEnum): 'BASE_DAY' | 'BASE_SMOOTH' | 'OMNI' {
  return kind as 'BASE_DAY' | 'BASE_SMOOTH' | 'OMNI';
}

function calculatedFields(assessment: PolicyAssessment, calculation: ProtectionCalculation) {
  return {
    lastZScore: assessment.z.toFixed(),
    lastVolatility: calculation.dailySigma.toFixed(),
    lastStatisticalMove: assessment.peril.statisticalMove.toFixed(),
    lastBoundary: assessment.peril.boundary.toFixed(),
    lastRequiredContribution: assessment.contribution.requiredContribution.toFixed(),
    calculatedAt: new Date(),
  };
}

/**
 * Which state the policy should be in, given what the engine just computed.
 *
 * Deliberately a pure function of the assessment: the same numbers always
 * imply the same state, so a transition can be justified from the event row
 * that recorded it.
 */
function nextState(
  current: ProtectionState,
  assessment: PolicyAssessment,
  policy: { declaredContribution: string; kind: PolicyKindEnum },
): ProtectionState {
  const required = assessment.contribution.requiredContribution;
  const declared = new Decimal(policy.declaredContribution);

  // Base Smooth's utilization is the most specific signal, so it wins.
  if (assessment.smooth) {
    const u = assessment.smooth.utilization;
    if (u.greaterThanOrEqualTo(1)) return 'POSITION_REDUCTION';
    if (u.isPositive()) return 'PROTECTION_ACTIVE';
  }

  // An underfunded Omni policy needs rebalancing before anything else.
  if (policy.kind === PolicyKindEnum.OMNI && declared.lessThan(required) && declared.isPositive()) {
    return 'REBALANCE_REQUIRED';
  }

  // Price inside the boundary is the warning, not the boundary being crossed:
  // by the time it is crossed the venue is usually already involved.
  if (assessment.standing === 'beyond-liquidation') return 'WARNING';

  return protectionStateMachine.can(current, 'ACTIVE') || current === 'ACTIVE'
    ? 'ACTIVE'
    : current;
}

function transitionReason(next: ProtectionState, assessment: PolicyAssessment): string {
  switch (next) {
    case 'PROTECTION_ACTIVE':
      return `Adverse excursion reached ${assessment.smooth?.utilization.times(100).toFixed(1)}% of the protection range.`;
    case 'POSITION_REDUCTION':
      return 'Protection fully utilised. Reduction recommended — FLT cannot place the trade.';
    case 'REBALANCE_REQUIRED':
      return 'The recalculated requirement exceeds the capital declared against this policy.';
    case 'WARNING':
      return 'The boundary now sits past where the venue would liquidate this position.';
    case 'ACTIVE':
      return 'Recalculated within normal parameters.';
    default:
      return 'State recalculated.';
  }
}

/**
 * Writes the §13 record. Always inside the caller's transaction.
 *
 * Missing values are `null`, never zero: "the venue did not report a mark
 * price" and "the mark price is nought" are different facts and an auditor has
 * to be able to tell them apart.
 */
async function recordTransition(
  tx: DbClient,
  policy: ProtectionPolicy,
  from: ProtectionState,
  to: ProtectionState,
  detail: {
    assessment?: PolicyAssessment;
    calculation?: ProtectionCalculation;
    position?: { size: string };
    action: string;
    currentContribution?: string;
  },
): Promise<string> {
  protectionStateMachine.assertTransition(from, to);

  const { assessment, calculation } = detail;
  const id = newId();

  await tx.protectionEvent.create({
    data: {
      id,
      policyId: policy.id,
      fromState: from,
      toState: to,
      underlyingPrice: calculation?.currentPrice.toFixed() ?? policy.referencePrice,
      markPrice: calculation?.currentPrice.toFixed() ?? null,
      volatility: calculation?.dailySigma.toFixed() ?? policy.lastVolatility ?? '0',
      volatilityModel: calculation?.volatility.model ?? policy.volatilityModel,
      percentile: policy.percentile,
      zScore: assessment?.z.toFixed() ?? policy.lastZScore ?? '0',
      zConvention: assessment?.zConvention ?? 'one-tailed',
      horizonDays: policy.horizonDays,
      boundary: assessment?.peril.boundary.toFixed() ?? policy.lastBoundary ?? '0',
      requiredContribution:
        assessment?.contribution.requiredContribution.toFixed() ??
        policy.lastRequiredContribution ??
        '0',
      currentContribution: detail.currentContribution ?? policy.declaredContribution,
      positionSize: detail.position?.size ?? '0',
      notional: assessment?.contribution.notional.toFixed() ?? policy.notional,
      action: detail.action,
      // Null rather than zero: FLT executes nothing, so there is no execution
      // price and no fee to report, and writing 0 would assert there was.
      executionPrice: null,
      fee: null,
      remainingProtectionBalance: null,
    },
  });

  return id;
}

async function appendLedger(
  tx: DbClient,
  policyId: string,
  entry: { kind: ProtectionLedgerKind; amount: string; reason: string; eventId?: string },
): Promise<void> {
  const previous = await tx.protectionLedgerEntry.findFirst({
    where: { policyId, kind: entry.kind },
    orderBy: { occurredAt: 'desc' },
  });

  const balanceAfter = new Decimal(previous?.balanceAfter ?? 0).plus(entry.amount);

  await tx.protectionLedgerEntry.create({
    data: {
      id: newId(),
      policyId,
      kind: entry.kind,
      amount: entry.amount,
      balanceAfter: balanceAfter.toFixed(),
      reason: entry.reason,
      eventId: entry.eventId ?? null,
    },
  });
}

async function closePolicy(
  policy: ProtectionPolicy,
  to: StateEnum,
  reason: string,
): Promise<ProtectionPolicy> {
  return prisma.$transaction(async (tx) => {
    await recordTransition(tx, policy, policy.state as ProtectionState, to as ProtectionState, {
      action: reason,
    });
    return tx.protectionPolicy.update({
      where: { id: policy.id },
      data: { state: to, closedAt: new Date() },
    });
  });
}

async function requireOwnPolicy(policyId: string, actor: User): Promise<ProtectionPolicy> {
  const policy = await prisma.protectionPolicy.findUnique({ where: { id: policyId } });
  if (!policy) throw new NotFoundError('Protection policy');
  if (policy.userId !== actor.id) {
    // Not found rather than forbidden: confirming a policy exists to somebody
    // who does not own it leaks that it exists.
    throw new NotFoundError('Protection policy');
  }
  return policy;
}

export { ForbiddenError };
