import { startOfUtcDay } from './entitlements';
import {
  AlgorithmKind,
  AlgorithmStatus,
  AlgorithmStrategy,
  AlgorithmStrategyType,
  AlgorithmVisibility,
  LedgerAccountKind,
  LedgerTransferKind,
  SubscriptionTier,
  isUniqueViolation,
  prisma,
  type AdminUser,
  type TradingAlgorithm,
  type User,
  type UserAlgorithm,
} from '@flt/db';
import { resolveAiSettings } from './platform-settings';
import { compileExpression, evaluateExpression } from './strategy-dsl';
import type { Candle } from '../ports/history';
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { accountFor, clientBalance, postTransfer } from './ledger';
import { assertMayTrade } from './kyc';
import { entitlementsFor } from './entitlements';
import { AuditAction, audit } from './audit';

/**
 * Automated trading offerings.
 *
 * Two offerings share one catalog: **Algo** (a deterministic, FLT-authored
 * strategy) and **AI** (an LLM over a prompt). Either way, activation is
 * **frictionless** — there is no entry cost. The participant allocates capital;
 * a **management fee of 2%/month of that capital** accrues, pro-rated daily at
 * 2%/31 per day, and is charged **on exit** (and monthly while running). FLT
 * never charges on the leveraged notional, only on the capital the participant
 * put up.
 *
 * ## Money never moves through the strategy
 *
 * This module decides a direction from candles (Algo) and stores a prompt (AI).
 * It cannot place an order and holds no key. The runner that can is the worker,
 * and even it only calls the same `openCustodyPerpPosition` a manual trade does.
 */

/** The ledger asset the fee is denominated in. */
const BILLING_ASSET = 'USDC';

/** Fee is quoted per month; the default billing period, in days. */
const DEFAULT_PERIOD_DAYS = 31;

// ── Fee arithmetic ──────────────────────────────────────────────────────────

/**
 * The daily accrual rate, as a fraction of capital per day.
 *
 * 2%/month over a 31-day period is 2%/31 ≈ 0.064516%/day. Kept as a fraction of
 * capital (not an amount) so it composes with any capital base.
 */
export function dailyFeeFraction(feeBps: number, periodDays: number): Decimal {
  const days = periodDays > 0 ? periodDays : DEFAULT_PERIOD_DAYS;
  return new Decimal(feeBps).dividedBy(10_000).dividedBy(days);
}

/**
 * The fee accrued on `capitalBase` between two instants.
 *
 * Pro-rated by elapsed time, so a partial month is charged a partial fee. A
 * $100 base for 15 days at 2%/31 per day is ~$0.97 — the worked example the
 * product quotes.
 */
export function accrueFee(
  capitalBase: Decimal,
  feeBps: number,
  periodDays: number,
  from: Date,
  to: Date,
): Decimal {
  const days = Math.max(0, (to.getTime() - from.getTime()) / 86_400_000);
  if (days === 0) return new Decimal(0);
  return capitalBase.times(dailyFeeFraction(feeBps, periodDays)).times(days);
}

/** One full period's fee on a capital base. */
function periodFee(capitalBase: Decimal, feeBps: number): Decimal {
  return capitalBase.times(new Decimal(feeBps).dividedBy(10_000));
}

// ── Catalog (offerings) ─────────────────────────────────────────────────────

export interface AlgorithmView {
  slug: string;
  name: string;
  description: string;
  kind: AlgorithmKind;
  strategy: AlgorithmStrategy;
  symbols: string[];
  maxLeverage: number;
  maxNotionalUsd: string;
  /** The monthly management fee, in basis points of allocated capital. */
  managementFeeBps: number;
  requiresPro: boolean;
  /** Ready-made prompts, for the AI offering. */
  promptRails: string[];
  periodDays: number;
  isFeatured: boolean;
  /** Who can see it, and whether the creator earns a share. */
  visibility: AlgorithmVisibility;
  revenueShareBps: number;
  /** How the signal is computed. */
  strategyType: AlgorithmStrategyType;
  composition: unknown;
  expression: string | null;
  creatorId: string | null;
}

function toView(algorithm: TradingAlgorithm): AlgorithmView {
  const rails = Array.isArray(algorithm.promptRails)
    ? (algorithm.promptRails as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];

  return {
    slug: algorithm.slug,
    name: algorithm.name,
    description: algorithm.description,
    kind: algorithm.kind,
    strategy: algorithm.strategy,
    symbols: algorithm.symbols,
    maxLeverage: algorithm.maxLeverage,
    maxNotionalUsd: algorithm.maxNotionalUsd,
    managementFeeBps: algorithm.managementFeeBps,
    requiresPro: algorithm.requiresPro,
    promptRails: rails,
    periodDays: algorithm.periodDays ?? DEFAULT_PERIOD_DAYS,
    isFeatured: algorithm.isFeatured,
    visibility: algorithm.visibility,
    revenueShareBps: algorithm.revenueShareBps,
    strategyType: algorithm.strategyType,
    composition: algorithm.composition,
    expression: algorithm.expression,
    creatorId: algorithm.creatorId,
  };
}

/**
 * The offerings a caller may see: FLT's, every published one, and their own.
 */
export async function listAlgorithms(userId?: string): Promise<AlgorithmView[]> {
  const rows = await prisma.tradingAlgorithm.findMany({
    where: {
      isActive: true,
      OR: [
        { visibility: AlgorithmVisibility.FLT },
        { visibility: AlgorithmVisibility.PUBLIC },
        ...(userId ? [{ creatorId: userId }] : []),
      ],
    },
    orderBy: [{ isFeatured: 'desc' }, { kind: 'asc' }, { name: 'asc' }],
  });
  return rows.map(toView);
}

export async function getAlgorithmBySlug(slug: string): Promise<AlgorithmView | null> {
  const row = await prisma.tradingAlgorithm.findUnique({ where: { slug } });
  return row && row.isActive ? toView(row) : null;
}

// ── A participant's activations ─────────────────────────────────────────────

export interface UserAlgorithmView {
  id: string;
  slug: string;
  name: string;
  kind: AlgorithmKind;
  status: AlgorithmStatus;
  capitalBase: string;
  accruedFeeUsd: string;
  managementFeeBps: number;
  startsAt: Date;
  endsAt: Date | null;
  lastRunAt: Date | null;
  /** What the offering allows, so settings can be edited within it. */
  strategy: AlgorithmStrategy;
  offeringSymbols: string[];
  offeringMaxLeverage: number;
  offeringMaxNotionalUsd: string;
  /** The participant's own settings, and the strategy knobs they chose. */
  settings: SubscriptionSettings;
  strategyParams: StrategyParams;
  /** Why the runner paused this itself, when a guardrail tripped. */
  pausedReason: string | null;
  /** Realised P&L across every close this subscription made, in USD. */
  realisedPnlUsd: string;
  /** The most recent decisions, newest first. */
  runs: {
    id: string;
    symbol: string;
    side: string;
    signal: string;
    status: string;
    reason: string | null;
    decidedAt: Date;
  }[];
}

export async function listUserAlgorithms(userId: string): Promise<UserAlgorithmView[]> {
  const rows = await prisma.userAlgorithm.findMany({
    where: { userId },
    include: {
      algorithm: true,
      runs: { orderBy: { decidedAt: 'desc' }, take: 12 },
    },
    orderBy: { createdAt: 'desc' },
  });

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      slug: row.algorithm.slug,
      name: row.algorithm.name,
      kind: row.algorithm.kind,
      status: row.status,
      capitalBase: row.capitalBase,
      accruedFeeUsd: row.accruedFeeUsd.toString(),
      managementFeeBps: row.algorithm.managementFeeBps,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      lastRunAt: row.lastRunAt,
      strategy: row.algorithm.strategy,
      offeringSymbols: row.algorithm.symbols,
      offeringMaxLeverage: row.algorithm.maxLeverage,
      offeringMaxNotionalUsd: row.algorithm.maxNotionalUsd,
      settings: readSubscriptionSettings(row.settings),
      strategyParams: readStrategyParams(row.strategyParams ?? row.algorithm.params),
      pausedReason: row.pausedReason,
      realisedPnlUsd: (await realisedPnlForSubscription(row.id)).toFixed(2),
      runs: row.runs.map((run) => ({
        id: run.id,
        symbol: run.symbol,
        side: run.side,
        signal: run.signal,
        status: run.status,
        reason: run.reason,
        decidedAt: run.decidedAt,
      })),
    })),
  );
}

// ── Per-subscription settings and guardrails ────────────────────────────────

/**
 * What a participant may set on their own subscription.
 *
 * Every field narrows the offering; none widens it. An offering is published
 * with a leverage ceiling, a set of markets and a per-trade size, and those are
 * the terms other people chose it on, so a participant can trade fewer markets,
 * smaller, at lower leverage, but never more.
 *
 * The guardrails are the participant's own limits on top of that. The runner
 * checks them before every pass and pauses the subscription itself when one
 * trips, recording which. A limit that silently stops an algorithm reads as a
 * bug; one that says why reads as the control it is.
 */
export interface SubscriptionSettings {
  leverage?: number;
  symbols?: string[];
  notionalUsd?: string;
  /** Pause once realised losses reach this share of the capital base. */
  maxDrawdownPct?: number;
  /** Pause once today's realised losses reach this many dollars. */
  dailyLossUsd?: string;
  /** Pause at this moment (ISO date). */
  endsAt?: string;
}

export function readSubscriptionSettings(raw: unknown): SubscriptionSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as SubscriptionSettings;
}

/**
 * Validates raw settings against the offering and returns the canonical form.
 * Throws with a message naming the field that is out of bounds.
 */
export function normaliseSubscriptionSettings(
  algorithm: TradingAlgorithm,
  raw: unknown,
): SubscriptionSettings {
  const input = readSubscriptionSettings(raw);
  const out: SubscriptionSettings = {};

  if (input.leverage !== undefined && input.leverage !== null) {
    const leverage = Math.floor(Number(input.leverage));
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > algorithm.maxLeverage) {
      throw new ValidationError(
        `Leverage must be between 1x and ${algorithm.maxLeverage}x on this offering.`,
      );
    }
    out.leverage = leverage;
  }

  if (Array.isArray(input.symbols)) {
    const allowed = new Set(algorithm.symbols.map((symbol) => symbol.toUpperCase()));
    const chosen = [...new Set(input.symbols.map((symbol) => String(symbol).toUpperCase()))];
    if (chosen.length === 0) throw new ValidationError('Choose at least one market to trade.');
    const outside = chosen.filter((symbol) => !allowed.has(symbol));
    if (outside.length > 0) {
      throw new ValidationError(`This offering does not trade ${outside.join(', ')}.`);
    }
    out.symbols = chosen;
  }

  if (
    input.notionalUsd !== undefined &&
    input.notionalUsd !== null &&
    String(input.notionalUsd).trim() !== ''
  ) {
    const notional = new Decimal(String(input.notionalUsd));
    const ceiling = new Decimal(algorithm.maxNotionalUsd);
    if (!notional.isFinite() || notional.lessThanOrEqualTo(0) || notional.greaterThan(ceiling)) {
      throw new ValidationError(
        `Size per trade must be above $0 and at most $${ceiling.toFixed()}.`,
      );
    }
    out.notionalUsd = notional.toFixed();
  }

  if (input.maxDrawdownPct !== undefined && input.maxDrawdownPct !== null) {
    const pct = Number(input.maxDrawdownPct);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new ValidationError('The drawdown limit must be between 0% and 100% of capital.');
    }
    out.maxDrawdownPct = pct;
  }

  if (
    input.dailyLossUsd !== undefined &&
    input.dailyLossUsd !== null &&
    String(input.dailyLossUsd).trim() !== ''
  ) {
    const cap = new Decimal(String(input.dailyLossUsd));
    if (!cap.isFinite() || cap.lessThanOrEqualTo(0)) {
      throw new ValidationError('The daily loss cap must be a positive dollar amount.');
    }
    out.dailyLossUsd = cap.toFixed();
  }

  if (input.endsAt) {
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= Date.now()) {
      throw new ValidationError('The end date must be in the future.');
    }
    out.endsAt = endsAt.toISOString();
  }

  return out;
}

/** Strategy knobs a participant may set, clamped to sane ranges. */
export function normaliseStrategyParams(raw: unknown): StrategyParams {
  const input = readStrategyParams(raw);
  const out: StrategyParams = {};
  const whole = (value: unknown, min: number, max: number) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
  };
  if (input.fast !== undefined) out.fast = whole(input.fast, 1, 500);
  if (input.slow !== undefined) out.slow = whole(input.slow, 2, 1000);
  if (input.window !== undefined) out.window = whole(input.window, 2, 1000);
  if (input.lookback !== undefined) out.lookback = whole(input.lookback, 1, 1000);
  if (input.thresholdBps !== undefined) out.thresholdBps = whole(input.thresholdBps, 0, 10_000);
  if (out.fast !== undefined && out.slow !== undefined && out.slow <= out.fast) {
    throw new ValidationError('The slow average has to be longer than the fast one.');
  }
  return out;
}

/**
 * Realised P&L for one subscription, in USD, from the ledger.
 *
 * Read from the `perp-pnl:perp-close:<orderId>` settlements of the closes this
 * subscription placed, so it is the figure that actually moved the
 * participant's balance rather than an estimate from marks.
 */
export async function realisedPnlForSubscription(
  userAlgorithmId: string,
  since?: Date,
): Promise<Decimal> {
  const closes = await prisma.algorithmRun.findMany({
    where: {
      userAlgorithmId,
      status: 'closed',
      perpOrderId: { not: null },
      ...(since ? { decidedAt: { gte: since } } : {}),
    },
    select: { perpOrderId: true },
  });
  if (closes.length === 0) return new Decimal(0);

  const entries = await prisma.ledgerEntry.findMany({
    where: {
      transfer: {
        kind: LedgerTransferKind.TRADE_SETTLEMENT,
        reference: { in: closes.map((run) => `perp-pnl:perp-close:${run.perpOrderId}`) },
      },
      account: { kind: LedgerAccountKind.USER_AVAILABLE },
    },
    select: { amount: true },
  });

  // USER_AVAILABLE is a credit balance: a gain is posted negative.
  return entries.reduce(
    (sum, entry) => sum.minus(new Decimal(entry.amount.toString())),
    new Decimal(0),
  );
}

export type GuardrailCode = 'ENDED' | 'MAX_DRAWDOWN' | 'DAILY_LOSS';

/** Which guardrail, if any, says this subscription must stop now. */
export async function evaluateGuardrails(row: UserAlgorithm): Promise<GuardrailCode | null> {
  const settings = readSubscriptionSettings(row.settings);

  const endsAt = settings.endsAt ? new Date(settings.endsAt) : row.endsAt;
  if (endsAt && endsAt.getTime() <= Date.now()) return 'ENDED';

  if (settings.maxDrawdownPct) {
    const pnl = await realisedPnlForSubscription(row.id);
    const limit = new Decimal(row.capitalBase).times(settings.maxDrawdownPct).dividedBy(100);
    if (pnl.negated().greaterThanOrEqualTo(limit)) return 'MAX_DRAWDOWN';
  }

  if (settings.dailyLossUsd) {
    const today = await realisedPnlForSubscription(row.id, startOfUtcDay());
    if (today.negated().greaterThanOrEqualTo(new Decimal(settings.dailyLossUsd))) {
      return 'DAILY_LOSS';
    }
  }

  return null;
}

/** Pauses a subscription because a guardrail tripped, and records which. */
export async function pauseForGuardrail(row: UserAlgorithm, code: GuardrailCode): Promise<void> {
  await prisma.userAlgorithm.update({
    where: { id: row.id },
    data: { status: AlgorithmStatus.PAUSED, pausedReason: code },
  });
  await audit(prisma, {
    action: AuditAction.ALGORITHM_STATUS_CHANGED,
    actorType: 'SYSTEM',
    actorUserId: row.userId,
    entityType: 'user_algorithm',
    entityId: row.id,
    after: { status: AlgorithmStatus.PAUSED, guardrail: code },
  });
}

/**
 * Updates a running subscription's settings without stopping it.
 *
 * Editing is not a cancel: no fee is settled and the subscription keeps its
 * history. The new settings apply from the runner's next pass.
 */
export async function updateAlgorithmSettings(
  user: User,
  id: string,
  input: { settings?: unknown; strategyParams?: unknown },
): Promise<UserAlgorithm> {
  const row = await prisma.userAlgorithm.findFirst({
    where: { id, userId: user.id },
    include: { algorithm: true },
  });
  if (!row) throw new NotFoundError('Algorithm subscription');
  if (row.status === AlgorithmStatus.CANCELLED || row.status === AlgorithmStatus.EXPIRED) {
    throw new ValidationError(
      'This subscription has ended. Activate it again to change its settings.',
    );
  }

  const settings = normaliseSubscriptionSettings(row.algorithm, input.settings);
  const strategyParams =
    row.algorithm.kind === AlgorithmKind.AI
      ? row.strategyParams
      : normaliseStrategyParams(input.strategyParams);

  const updated = await prisma.userAlgorithm.update({
    where: { id },
    data: { settings: settings as never, strategyParams: strategyParams as never },
  });

  await audit(prisma, {
    action: AuditAction.ALGORITHM_STATUS_CHANGED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'user_algorithm',
    entityId: id,
    after: { settings, strategyParams },
  });

  return updated;
}

export interface ActivateAlgorithmInput {
  slug: string;
  /** USD, as a decimal string. The fee base — NOT the leveraged notional. */
  capitalBase: string;
  /** ALGO: which deterministic strategy, and its parameters. */
  strategy?: AlgorithmStrategy;
  strategyParams?: Record<string, unknown>;
  /** AI: the participant's prompt (or a chosen rail). */
  prompt?: string;
  /** Leverage, markets, size and guardrails, bounded by the offering. */
  settings?: Record<string, unknown>;
}

/**
 * Activates an offering. **No entry cost** — it records the capital base and
 * starts the daily accrual.
 *
 * Reactivating after a cancel reuses the row, so `(userId, algorithmId)` stays
 * one row and the runner can never pick up two subscriptions for one offering.
 */
export async function activateAlgorithm(
  user: User,
  input: ActivateAlgorithmInput,
  context: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<{ subscription: UserAlgorithm; algorithm: TradingAlgorithm }> {
  assertMayTrade(user);

  const algorithm = await prisma.tradingAlgorithm.findUnique({ where: { slug: input.slug } });
  if (!algorithm || !algorithm.isActive) throw new NotFoundError('Offering');

  const capitalBase = new Decimal(input.capitalBase);
  if (!capitalBase.isFinite() || capitalBase.lessThanOrEqualTo(0)) {
    throw new ValidationError('Allocate a positive capital amount');
  }

  // The AI offering is FLT Pro only; the Algo offering is open to everyone.
  if (algorithm.requiresPro) {
    const entitlements = await entitlementsFor(user.id);
    if (entitlements.tier !== SubscriptionTier.PRO && entitlements.tier !== SubscriptionTier.ELITE) {
      throw new ForbiddenError('AI trading is only available to FLT Pro users.');
    }
  }

  let prompt: string | null = null;
  let strategyParams: Record<string, unknown> | null = null;

  if (algorithm.kind === AlgorithmKind.AI) {
    if (!(await resolveAiSettings()).enabled) {
      throw new ValidationError('AI trading is not available yet — an operator must switch it on.');
    }
    prompt = (input.prompt ?? '').trim();
    if (prompt.length < 8) throw new ValidationError('Write a prompt of at least 8 characters.');
    if (prompt.length > 1_000) throw new ValidationError('Keep the prompt under 1000 characters.');
  } else {
    strategyParams = normaliseStrategyParams(input.strategyParams ?? {}) as Record<string, unknown>;
  }

  const settings = normaliseSubscriptionSettings(algorithm, input.settings ?? {});

  const existing = await prisma.userAlgorithm.findFirst({
    where: { userId: user.id, algorithmId: algorithm.id },
  });
  if (existing?.status === AlgorithmStatus.ACTIVE) {
    throw new ValidationError(`${algorithm.name} is already running on your account.`);
  }

  const id = existing?.id ?? newId();
  const now = new Date();

  const data = {
    status: AlgorithmStatus.ACTIVE,
    capitalBase: capitalBase.toFixed(),
    accruedFeeUsd: new Decimal(0),
    feeAccruedAt: now,
    strategyParams: strategyParams as never,
    settings: settings as never,
    pausedReason: null,
    prompt,
    startsAt: now,
    endsAt: null,
    lastRunAt: null,
    cancelledAt: null,
    cancelReason: null,
  };

  try {
    const subscription = existing
      ? await prisma.userAlgorithm.update({ where: { id }, data })
      : await prisma.userAlgorithm.create({
          data: { id, userId: user.id, algorithmId: algorithm.id, ...data },
        });

    await audit(prisma, {
      action: AuditAction.ALGORITHM_PURCHASED,
      actorType: 'USER',
      actorUserId: user.id,
      entityType: 'user_algorithm',
      entityId: subscription.id,
      after: {
        algorithm: algorithm.slug,
        kind: algorithm.kind,
        capitalBase: capitalBase.toFixed(),
        managementFeeBps: algorithm.managementFeeBps,
      },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      requestId: context.requestId ?? null,
    });

    return { subscription, algorithm };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const row = await prisma.userAlgorithm.findFirstOrThrow({
        where: { userId: user.id, algorithmId: algorithm.id },
      });
      return { subscription: row, algorithm };
    }
    throw error;
  }
}

/**
 * Pauses, resumes or stops a subscription.
 *
 * **Stop settles the fee on exit** — the accrued amount is charged, pro-rated to
 * the moment of exit — then marks the row CANCELLED. This is the "frictionless"
 * part: nothing is charged up front, and the only charge on an early exit is the
 * pro-rated fee for the time actually held.
 *
 * Stop never closes an open position: stopping the automation is not a reason to
 * force an exit at whatever the market happens to be doing.
 */
export async function setAlgorithmStatus(
  user: User,
  id: string,
  status: AlgorithmStatus,
  reason?: string,
): Promise<UserAlgorithm> {
  const row = await prisma.userAlgorithm.findFirst({
    where: { id, userId: user.id },
    include: { algorithm: true },
  });
  if (!row) throw new NotFoundError('Algorithm subscription');

  if (status === AlgorithmStatus.CANCELLED) {
    await settleAlgorithmFee(row, { reason: reason ?? 'Stopped by participant' });
  }

  const cancelling = status === AlgorithmStatus.CANCELLED;

  const updated = await prisma.userAlgorithm.update({
    where: { id },
    data: {
      status,
      cancelledAt: cancelling ? new Date() : null,
      cancelReason: cancelling ? (reason?.trim() || 'Stopped by participant') : null,
      // A participant resuming or stopping has seen why it paused.
      pausedReason: null,
    },
  });

  await audit(prisma, {
    action: cancelling ? AuditAction.ALGORITHM_CANCELLED : AuditAction.ALGORITHM_STATUS_CHANGED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'user_algorithm',
    entityId: id,
    after: { status, reason: reason ?? null },
  });

  return updated;
}

// ── Fee accrual and settlement (the worker drives these) ────────────────────

/**
 * Accrues the fee for every running subscription up to now.
 *
 * Pure bookkeeping: it only updates `accruedFeeUsd`/`feeAccruedAt`. Charging the
 * ledger is a separate step, so an accrual never fails because a balance was
 * momentarily short — the amount owed simply keeps accumulating.
 */
export async function accrueAlgorithmFees(now: Date = new Date()): Promise<{ accrued: number }> {
  const running = await prisma.userAlgorithm.findMany({
    where: { status: AlgorithmStatus.ACTIVE },
    include: { algorithm: true },
  });

  let accrued = 0;
  for (const row of running) {
    const amount = accrueFee(
      new Decimal(row.capitalBase),
      row.algorithm.managementFeeBps,
      row.algorithm.periodDays ?? DEFAULT_PERIOD_DAYS,
      row.feeAccruedAt,
      now,
    );
    if (amount.lessThanOrEqualTo(0)) continue;

    await prisma.userAlgorithm.update({
      where: { id: row.id },
      data: { accruedFeeUsd: { increment: amount.toFixed() }, feeAccruedAt: now },
    });
    accrued += 1;
  }

  return { accrued };
}

/**
 * Charges the fee for every running subscription that has accrued a full
 * period — the "we take 2% every month" half of the model. Partial months are
 * left accruing until either the next month or the exit.
 */
export async function settleDueAlgorithmFees(): Promise<{ settled: number; skipped: number }> {
  const running = await prisma.userAlgorithm.findMany({
    where: { status: AlgorithmStatus.ACTIVE },
    include: { algorithm: true },
  });

  let settled = 0;
  let skipped = 0;

  for (const row of running) {
    const period = periodFee(new Decimal(row.capitalBase), row.algorithm.managementFeeBps);
    if (period.lessThanOrEqualTo(0)) continue;

    let accrued = new Decimal(row.accruedFeeUsd.toString());
    let index = 0;
    while (accrued.greaterThanOrEqualTo(period)) {
      const reference = `algorithm-fee:${row.id}:${row.feeAccruedAt.getTime()}:${index}`;
      try {
        await chargeFee(row, period, reference, `Algorithm fee (month) — ${row.algorithm.name}`);
        accrued = accrued.minus(period);
        await prisma.userAlgorithm.update({
          where: { id: row.id },
          data: { accruedFeeUsd: accrued.toFixed() },
        });
        settled += 1;
        index += 1;
      } catch (error) {
        // Short balance: leave the fee accrued and try again next pass.
        skipped += 1;
        console.warn('[algorithms] monthly fee charge skipped', {
          subscriptionId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  }

  return { settled, skipped };
}

/**
 * Settles everything accrued so far on one subscription — the on-exit charge.
 * Returns the amount charged (0 if nothing was owed or the balance was short).
 */
export async function settleAlgorithmFee(
  row: UserAlgorithm & { algorithm: TradingAlgorithm },
  options: { reason: string },
): Promise<Decimal> {
  const now = new Date();
  const fresh = accrueFee(
    new Decimal(row.capitalBase),
    row.algorithm.managementFeeBps,
    row.algorithm.periodDays ?? DEFAULT_PERIOD_DAYS,
    row.feeAccruedAt,
    now,
  );
  const owed = new Decimal(row.accruedFeeUsd.toString()).plus(fresh);
  if (owed.lessThanOrEqualTo(0)) return new Decimal(0);

  const reference = `algorithm-fee:${row.id}:exit:${row.feeAccruedAt.getTime()}`;

  try {
    await chargeFee(row, owed, reference, `Algorithm fee (exit) — ${row.algorithm.name}: ${options.reason}`);
  } catch (error) {
    // The fee is still owed; leave the accrual in place so a later pass can
    // collect it once the balance can cover it.
    await prisma.userAlgorithm.update({
      where: { id: row.id },
      data: { accruedFeeUsd: owed.toFixed(), feeAccruedAt: now },
    });
    console.warn('[algorithms] exit fee charge skipped', {
      subscriptionId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Decimal(0);
  }

  await prisma.userAlgorithm.update({
    where: { id: row.id },
    data: { accruedFeeUsd: '0', feeAccruedAt: now },
  });
  return owed;
}

/** The creator's split of a settled fee, when the offering is a published one. */
function creatorSplitFor(algorithm: TradingAlgorithm): { creatorId: string; bps: number } | null {
  if (algorithm.visibility !== AlgorithmVisibility.PUBLIC) return null;
  if (!algorithm.creatorId || algorithm.revenueShareBps <= 0) return null;
  return { creatorId: algorithm.creatorId, bps: algorithm.revenueShareBps };
}

/**
 * Debits the subscriber's balance, splitting the fee between FLT and — for a
 * published offering — its creator. Pre-checks sufficiency. Idempotent on the
 * reference, so a retried settlement never pays a creator twice.
 */
async function chargeFee(
  row: UserAlgorithm & { algorithm: TradingAlgorithm },
  amount: Decimal,
  reference: string,
  memo: string,
): Promise<void> {
  const userId = row.userId;
  const balance = await clientBalance(userId, BILLING_ASSET);
  if (balance.available.lessThan(amount)) {
    throw new ValidationError(
      `Insufficient available ${BILLING_ASSET} to charge the algorithm fee.`,
      { needed: amount.toFixed(), available: balance.available.toFixed() },
    );
  }

  const split = creatorSplitFor(row.algorithm);
  const creatorShare = split ? amount.times(new Decimal(split.bps).dividedBy(10_000)) : new Decimal(0);
  const retained = amount.minus(creatorShare);

  await prisma.$transaction(async (tx) => {
    const available = await accountFor(
      { kind: LedgerAccountKind.USER_AVAILABLE, userId, asset: BILLING_ASSET },
      tx,
    );
    const revenue = await accountFor({ kind: LedgerAccountKind.FEE_REVENUE, asset: BILLING_ASSET }, tx);

    const entries = [
      { accountId: available.id, amount },
      { accountId: revenue.id, amount: retained.negated() },
    ];

    if (split && creatorShare.greaterThan(0)) {
      const creatorAvailable = await accountFor(
        { kind: LedgerAccountKind.USER_AVAILABLE, userId: split.creatorId, asset: BILLING_ASSET },
        tx,
      );
      entries.push({ accountId: creatorAvailable.id, amount: creatorShare.negated() });
    }

    await postTransfer({ kind: LedgerTransferKind.FEE, reference, memo, entries }, tx);
  });

  if (split && creatorShare.greaterThan(0)) {
    try {
      await prisma.creatorEarning.create({
        data: {
          id: newId(),
          creatorId: split.creatorId,
          algorithmId: row.algorithm.id,
          subscriberUserId: userId,
          settlementRef: reference,
          amountUsd: creatorShare,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    await prisma.userAlgorithm.update({
      where: { id: row.id },
      data: { creatorEarningsUsd: { increment: creatorShare.toFixed() } },
    });
  }
}

// ── Strategy (deterministic / Algo offering) ────────────────────────────────

export interface StrategyParams {
  fast?: number;
  slow?: number;
  window?: number;
  lookback?: number;
  thresholdBps?: number;
}

export function readStrategyParams(raw: unknown): StrategyParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as StrategyParams;
}

export interface SignalResult {
  side: 'LONG' | 'SHORT';
  signal: string;
}

function sma(values: number[], window: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= window) sum -= values[i - window]!;
    if (i >= window - 1) out.push(sum / window);
  }
  return out;
}

/** Turns candles into a direction, or null for "no opinion". Pure. */
export function computeSignal(
  strategy: AlgorithmStrategy,
  params: StrategyParams,
  candles: Candle[],
): SignalResult | null {
  const closes = candles.map((candle) => candle.close).filter((value) => Number.isFinite(value));
  if (closes.length < 3) return null;
  const last = closes[closes.length - 1]!;

  switch (strategy) {
    case AlgorithmStrategy.MA_CROSSOVER: {
      const fast = Math.max(1, Math.floor(params.fast ?? 12));
      const slow = Math.max(fast + 1, Math.floor(params.slow ?? 48));
      if (closes.length < slow) return null;
      const fastAvg = sma(closes, fast).at(-1)!;
      const slowAvg = sma(closes, slow).at(-1)!;
      const side = fastAvg >= slowAvg ? 'LONG' : 'SHORT';
      return { side, signal: `MA_CROSSOVER_${side}` };
    }
    case AlgorithmStrategy.MEAN_REVERSION: {
      const window = Math.max(2, Math.floor(params.window ?? 24));
      if (closes.length < window) return null;
      const avg = sma(closes, window).at(-1)!;
      const side = last >= avg ? 'SHORT' : 'LONG';
      return { side, signal: `MEAN_REVERSION_${side}` };
    }
    case AlgorithmStrategy.MOMENTUM: {
      const lookback = Math.max(1, Math.floor(params.lookback ?? 24));
      if (closes.length < lookback + 1) return null;
      const past = closes[closes.length - 1 - lookback]!;
      const changeBps = past === 0 ? 0 : ((last - past) / past) * 10_000;
      const threshold = params.thresholdBps ?? 0;
      if (Math.abs(changeBps) < threshold) return null;
      const side = changeBps > 0 ? 'LONG' : 'SHORT';
      return { side, signal: `MOMENTUM_${side}` };
    }
    default:
      return null;
  }
}

// ── Run log (used by the runner) ────────────────────────────────────────────

export interface AlgorithmRunInput {
  userAlgorithmId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  signal: string;
  perpOrderId?: string | null;
  status: string;
  reason?: string | null;
}

export async function recordAlgorithmRun(input: AlgorithmRunInput): Promise<void> {
  await prisma.algorithmRun.create({
    data: {
      id: newId(),
      userAlgorithmId: input.userAlgorithmId,
      symbol: input.symbol,
      side: input.side,
      signal: input.signal,
      perpOrderId: input.perpOrderId ?? null,
      status: input.status,
      reason: input.reason ?? null,
    },
  });
}

export async function touchAlgorithmRun(userAlgorithmId: string): Promise<void> {
  await prisma.userAlgorithm.update({
    where: { id: userAlgorithmId },
    data: { lastRunAt: new Date() },
  });
}

// ── Admin catalog management ────────────────────────────────────────────────

export interface AlgorithmWriteInput {
  slug: string;
  kind?: AlgorithmKind;
  name: string;
  description: string;
  strategy?: AlgorithmStrategy;
  params?: Record<string, unknown>;
  symbols: string[];
  maxLeverage: number;
  maxNotionalUsd: string;
  managementFeeBps?: number;
  requiresPro?: boolean;
  systemPrompt?: string | null;
  promptRails?: string[];
  periodDays?: number | null;
  isActive?: boolean;
  isFeatured?: boolean;
  strategyType?: AlgorithmStrategyType;
  composition?: CompositeSpec | null;
  expression?: string | null;
}

/** The offerings awaiting operator review before publishing. */
export async function listPendingOfferings(): Promise<TradingAlgorithm[]> {
  return prisma.tradingAlgorithm.findMany({
    where: { visibility: AlgorithmVisibility.PENDING_REVIEW },
    orderBy: { createdAt: 'asc' },
  });
}

/** Approve a published offering to PUBLIC, or reject it back to PRIVATE. */
export async function reviewOffering(
  admin: AdminUser,
  slug: string,
  approve: boolean,
): Promise<TradingAlgorithm> {
  const row = await prisma.tradingAlgorithm.findUnique({ where: { slug } });
  if (!row) throw new NotFoundError('Offering');

  const updated = await prisma.tradingAlgorithm.update({
    where: { id: row.id },
    data: approve
      ? { visibility: AlgorithmVisibility.PUBLIC }
      : { visibility: AlgorithmVisibility.PRIVATE, revenueShareBps: 0 },
  });

  await audit(prisma, {
    action: AuditAction.ADMIN_ALGORITHM_CHANGED,
    actorType: 'ADMIN',
    actorAdminId: admin.id,
    entityType: 'trading_algorithm',
    entityId: row.id,
    after: { approve, visibility: updated.visibility },
  });

  return updated;
}

export async function listAllAlgorithms(): Promise<TradingAlgorithm[]> {
  return prisma.tradingAlgorithm.findMany({
    orderBy: [{ isActive: 'desc' }, { kind: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function createAlgorithm(
  admin: AdminUser,
  input: AlgorithmWriteInput,
): Promise<TradingAlgorithm> {
  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{2,64}$/.test(slug)) {
    throw new ValidationError('Slug must be 2–64 characters of lowercase letters, digits or dashes');
  }
  if (input.symbols.length === 0) {
    throw new ValidationError('An offering needs at least one symbol');
  }

  const existing = await prisma.tradingAlgorithm.findUnique({ where: { slug } });
  if (existing) {
    throw new ValidationError(`An offering with the slug "${slug}" already exists.`);
  }

  const kind = input.kind ?? AlgorithmKind.ALGO;

  const row = await prisma.tradingAlgorithm.create({
    data: {
      id: newId(),
      slug,
      kind,
      name: input.name.trim(),
      description: input.description.trim(),
      strategy: input.strategy ?? AlgorithmStrategy.MOMENTUM,
      params: (input.params ?? {}) as never,
      symbols: input.symbols,
      maxLeverage: input.maxLeverage,
      maxNotionalUsd: input.maxNotionalUsd,
      managementFeeBps: input.managementFeeBps ?? 200,
      // The AI offering is Pro-only, enforced in code as well as the row.
      requiresPro: input.requiresPro ?? kind === AlgorithmKind.AI,
      strategyType: input.strategyType ?? undefined,
      composition: (input.composition ?? undefined) as never,
      expression: input.expression ?? undefined,
      systemPrompt: input.systemPrompt ?? null,
      promptRails: (input.promptRails ?? []) as never,
      periodDays: input.periodDays ?? DEFAULT_PERIOD_DAYS,
      isActive: input.isActive ?? false,
      isFeatured: input.isFeatured ?? false,
      createdById: admin.id,
    },
  });

  await audit(prisma, {
    action: AuditAction.ADMIN_ALGORITHM_CHANGED,
    actorType: 'ADMIN',
    actorAdminId: admin.id,
    entityType: 'trading_algorithm',
    entityId: row.id,
    after: { created: row.slug, kind: row.kind, isActive: row.isActive },
  });

  return row;
}

export async function updateAlgorithm(
  admin: AdminUser,
  id: string,
  input: Partial<AlgorithmWriteInput>,
): Promise<TradingAlgorithm> {
  const existing = await prisma.tradingAlgorithm.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Offering');

  const data: Record<string, unknown> = {};
  if (input.kind !== undefined) data.kind = input.kind;
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.description !== undefined) data.description = input.description.trim();
  if (input.strategy !== undefined) data.strategy = input.strategy;
  if (input.params !== undefined) data.params = input.params;
  if (input.symbols !== undefined) {
    if (input.symbols.length === 0) throw new ValidationError('An offering needs at least one symbol');
    data.symbols = input.symbols;
  }
  if (input.maxLeverage !== undefined) data.maxLeverage = input.maxLeverage;
  if (input.maxNotionalUsd !== undefined) data.maxNotionalUsd = input.maxNotionalUsd;
  if (input.managementFeeBps !== undefined) data.managementFeeBps = input.managementFeeBps;
  if (input.requiresPro !== undefined) data.requiresPro = input.requiresPro;
  if (input.systemPrompt !== undefined) data.systemPrompt = input.systemPrompt;
  if (input.promptRails !== undefined) data.promptRails = input.promptRails;
  if (input.periodDays !== undefined) data.periodDays = input.periodDays;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.isFeatured !== undefined) data.isFeatured = input.isFeatured;

  const row = await prisma.tradingAlgorithm.update({ where: { id }, data });

  await audit(prisma, {
    action: AuditAction.ADMIN_ALGORITHM_CHANGED,
    actorType: 'ADMIN',
    actorAdminId: admin.id,
    entityType: 'trading_algorithm',
    entityId: id,
    before: { isActive: existing.isActive, managementFeeBps: existing.managementFeeBps },
    after: { isActive: row.isActive, managementFeeBps: row.managementFeeBps },
  });

  return row;
}

// ── Composable / custom strategies ─────────────────────────────────────────

export interface CompositeMember {
  strategy: AlgorithmStrategy;
  params?: StrategyParams;
  weight?: number;
}
export interface CompositeSpec {
  members: CompositeMember[];
  combine?: 'MAJORITY' | 'WEIGHTED';
}

export interface StrategyDescriptor {
  strategyType: AlgorithmStrategyType;
  strategy: AlgorithmStrategy;
  params: StrategyParams;
  composition?: CompositeSpec | null;
  expression?: string | null;
}

/**
 * Turns candles into a direction using whichever strategy type the offering
 * declares — a built-in, a vote over several, or a restricted-language
 * expression. Pure, and the one place the runner and the backtester both call.
 */
export function evaluateStrategy(desc: StrategyDescriptor, candles: Candle[]): SignalResult | null {
  if (desc.strategyType === AlgorithmStrategyType.COMPOSITE) {
    const spec = desc.composition;
    if (!spec || !Array.isArray(spec.members) || spec.members.length === 0) return null;
    let longScore = 0;
    let shortScore = 0;
    for (const member of spec.members) {
      const signal = computeSignal(member.strategy, member.params ?? {}, candles);
      if (!signal) continue;
      const weight = spec.combine === 'WEIGHTED' ? Math.max(0, member.weight ?? 1) : 1;
      if (signal.side === 'LONG') longScore += weight;
      else shortScore += weight;
    }
    if (longScore === 0 && shortScore === 0) return null;
    const side = longScore >= shortScore ? 'LONG' : 'SHORT';
    return { side, signal: `COMPOSITE_${side}` };
  }

  if (desc.strategyType === AlgorithmStrategyType.CUSTOM) {
    if (!desc.expression) return null;
    const value = evaluateExpression(desc.expression, candles);
    if (value === null || value === 0) return null;
    const side = value > 0 ? 'LONG' : 'SHORT';
    return { side, signal: `CUSTOM_${side}` };
  }

  return computeSignal(desc.strategy, desc.params, candles);
}

// ── Participant-authored offerings ─────────────────────────────────────────

/** The creator's share of an offering's fee, in basis points (50%). */
const CREATOR_REVENUE_SHARE_BPS = 5_000;

function slugify(value: string): string {
  const base = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  return base.length >= 2 ? base : 'algo';
}

export interface CreateOfferingInput {
  name: string;
  description?: string;
  symbols: string[];
  maxLeverage: number;
  maxNotionalUsd: string;
  strategyType: AlgorithmStrategyType;
  strategy?: AlgorithmStrategy;
  params?: Record<string, unknown>;
  composition?: CompositeSpec | null;
  expression?: string | null;
  managementFeeBps?: number;
}

/**
 * "Push to algo": turns a backtested configuration into an offering the
 * participant owns and can activate. It starts PRIVATE; publishing is a
 * separate, deliberate step.
 */
export async function createOfferingFromBacktest(
  user: User,
  input: CreateOfferingInput,
): Promise<TradingAlgorithm> {
  assertMayTrade(user);

  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError('Give the algo a name');
  if (input.symbols.length === 0) throw new ValidationError('Choose at least one symbol');
  const maxNotional = new Decimal(input.maxNotionalUsd);
  if (!maxNotional.isFinite() || maxNotional.lessThanOrEqualTo(0)) {
    throw new ValidationError('Set a positive max notional');
  }

  if (input.strategyType === AlgorithmStrategyType.CUSTOM) {
    if (!input.expression) throw new ValidationError('Write an expression');
    compileExpression(input.expression);
  }
  if (input.strategyType === AlgorithmStrategyType.COMPOSITE) {
    if (!input.composition || input.composition.members.length === 0) {
      throw new ValidationError('Add at least one strategy to the mix');
    }
  }

  let slug = `${slugify(name)}-${newId().replace(/-/g, '').slice(-6)}`;
  while (await prisma.tradingAlgorithm.findUnique({ where: { slug } })) {
    slug = `${slugify(name)}-${newId().replace(/-/g, '').slice(-6)}`;
  }

  const row = await prisma.tradingAlgorithm.create({
    data: {
      id: newId(),
      slug,
      kind: AlgorithmKind.ALGO,
      name,
      description: input.description?.trim() || `${name} — a participant-authored strategy.`,
      strategy: input.strategy ?? AlgorithmStrategy.MOMENTUM,
      params: (input.params ?? {}) as never,
      symbols: input.symbols,
      maxLeverage: input.maxLeverage,
      maxNotionalUsd: maxNotional.toFixed(),
      managementFeeBps: input.managementFeeBps ?? 200,
      requiresPro: false,
      strategyType: input.strategyType,
      composition: (input.composition ?? null) as never,
      expression: input.expression ?? null,
      visibility: AlgorithmVisibility.PRIVATE,
      revenueShareBps: 0,
      creatorId: user.id,
      isActive: true,
      isFeatured: false,
    },
  });

  await audit(prisma, {
    action: AuditAction.ALGORITHM_PURCHASED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'trading_algorithm',
    entityId: row.id,
    after: { created: row.slug, strategyType: row.strategyType, visibility: row.visibility },
  });

  return row;
}

export interface CreatorOfferingView {
  slug: string;
  name: string;
  visibility: AlgorithmVisibility;
  revenueShareBps: number;
  earningsUsd: string;
}

/** The participant's own offerings, with the revenue they have generated. */
export async function listMyOfferings(userId: string): Promise<CreatorOfferingView[]> {
  const rows = await prisma.tradingAlgorithm.findMany({
    where: { creatorId: userId },
    orderBy: { createdAt: 'desc' },
  });

  const out: CreatorOfferingView[] = [];
  for (const row of rows) {
    const agg = await prisma.creatorEarning.aggregate({
      where: { algorithmId: row.id },
      _sum: { amountUsd: true },
    });
    out.push({
      slug: row.slug,
      name: row.name,
      visibility: row.visibility,
      revenueShareBps: row.revenueShareBps,
      earningsUsd: new Decimal(agg._sum.amountUsd?.toString() ?? '0').toFixed(2),
    });
  }
  return out;
}

/**
 * Publishes or unpublishes a participant's offering.
 *
 * Publishing puts it in PENDING_REVIEW with a 50% creator share; an operator
 * approves it to PUBLIC. Unpublishing returns it to PRIVATE and clears the
 * share. Only the creator can do this.
 */
export async function setAlgorithmPublished(
  user: User,
  slug: string,
  publish: boolean,
  context: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<TradingAlgorithm> {
  const row = await prisma.tradingAlgorithm.findFirst({ where: { slug, creatorId: user.id } });
  if (!row) throw new NotFoundError('Offering');

  const updated = await prisma.tradingAlgorithm.update({
    where: { id: row.id },
    data: publish
      ? { visibility: AlgorithmVisibility.PENDING_REVIEW, revenueShareBps: CREATOR_REVENUE_SHARE_BPS }
      : { visibility: AlgorithmVisibility.PRIVATE, revenueShareBps: 0 },
  });

  await audit(prisma, {
    action: publish ? AuditAction.ALGORITHM_STATUS_CHANGED : AuditAction.ALGORITHM_CANCELLED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'trading_algorithm',
    entityId: row.id,
    after: { publish, visibility: updated.visibility, revenueShareBps: updated.revenueShareBps },
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    requestId: context.requestId ?? null,
  });

  return updated;
}
