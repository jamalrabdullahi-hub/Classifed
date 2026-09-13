import {
  AlgorithmKind,
  AlgorithmStatus,
  AlgorithmStrategy,
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
import { env } from '@flt/config';
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
  };
}

/** The active offerings, featured first. */
export async function listAlgorithms(): Promise<AlgorithmView[]> {
  const rows = await prisma.tradingAlgorithm.findMany({
    where: { isActive: true },
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
}

export async function listUserAlgorithms(userId: string): Promise<UserAlgorithmView[]> {
  const rows = await prisma.userAlgorithm.findMany({
    where: { userId },
    include: { algorithm: true },
    orderBy: { createdAt: 'desc' },
  });

  return rows.map((row) => ({
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
  }));
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
    if (!env().AI_ENABLED) {
      throw new ValidationError('AI trading is not available on this deployment yet.');
    }
    prompt = (input.prompt ?? '').trim();
    if (prompt.length < 8) throw new ValidationError('Write a prompt of at least 8 characters.');
    if (prompt.length > 1_000) throw new ValidationError('Keep the prompt under 1000 characters.');
  } else {
    strategyParams = input.strategyParams ?? {};
  }

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
    while (accrued.greaterThanOrEqualTo(period)) {
      try {
        await chargeFee(row.userId, period, row.id, `Algorithm fee (month) — ${row.algorithm.name}`);
        accrued = accrued.minus(period);
        await prisma.userAlgorithm.update({
          where: { id: row.id },
          data: { accruedFeeUsd: accrued.toFixed() },
        });
        settled += 1;
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

  try {
    await chargeFee(
      row.userId,
      owed,
      row.id,
      `Algorithm fee (exit) — ${row.algorithm.name}: ${options.reason}`,
    );
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

/** Debits the participant's balance into FLT revenue. Pre-checks sufficiency. */
async function chargeFee(
  userId: string,
  amount: Decimal,
  subscriptionId: string,
  memo: string,
): Promise<void> {
  const balance = await clientBalance(userId, BILLING_ASSET);
  if (balance.available.lessThan(amount)) {
    throw new ValidationError(
      `Insufficient available ${BILLING_ASSET} to charge the algorithm fee.`,
      { needed: amount.toFixed(), available: balance.available.toFixed() },
    );
  }

  const reference = `algorithm-fee:${subscriptionId}:${Date.now()}`;

  await prisma.$transaction(async (tx) => {
    const available = await accountFor(
      { kind: LedgerAccountKind.USER_AVAILABLE, userId, asset: BILLING_ASSET },
      tx,
    );
    const revenue = await accountFor(
      { kind: LedgerAccountKind.FEE_REVENUE, asset: BILLING_ASSET },
      tx,
    );

    await postTransfer(
      {
        kind: LedgerTransferKind.FEE,
        reference,
        memo,
        entries: [
          { accountId: available.id, amount },
          { accountId: revenue.id, amount: amount.negated() },
        ],
      },
      tx,
    );
  });
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
