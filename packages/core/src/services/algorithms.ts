import {
  AlgorithmStatus,
  AlgorithmStrategy,
  LedgerAccountKind,
  LedgerTransferKind,
  isUniqueViolation,
  Prisma,
  prisma,
  type AdminUser,
  type TradingAlgorithm,
  type User,
  type UserAlgorithm,
} from '@flt/db';
import type { Candle } from '../ports/history';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { accountFor, clientBalance, postTransfer } from './ledger';
import { assertMayTrade } from './kyc';
import { AuditAction, audit } from './audit';

/**
 * Trading algorithms.
 *
 * A catalog FLT authors, and the purchases of it. Buying one debits the
 * participant's ledger balance into FLT revenue and writes the subscription;
 * the strategy is then evaluated by the worker (`apps/worker/src/algorithms.ts`),
 * which places orders through the ordinary custody path — so every order an
 * algorithm places is subject to the same leverage, entitlement, balance and
 * insurance checks as a manual one.
 *
 * ## Money never moves through the strategy
 *
 * This module computes a direction from candles and nothing else. It cannot
 * place an order and it holds no key. The runner that can is deliberately
 * elsewhere, and even it only calls the same `openCustodyPerpPosition` the
 * manual ticket calls.
 *
 * ## Why buying is a ledger debit, not a wallet transfer
 *
 * Subscriptions and protection are bought on-chain (the participant signs an
 * ERC-20 transfer). Algorithms are bought from the custody balance instead:
 * the money is already inside FLT's ledger, so moving it is a double-entry
 * movement rather than a chain interaction — cheaper, atomic, and auditable in
 * the same ledger every other balance lives in.
 */

/** The ledger asset an algorithm is priced and charged in. */
const BILLING_ASSET = 'USDC';

// ── Catalog ─────────────────────────────────────────────────────────────────

export interface AlgorithmView {
  slug: string;
  name: string;
  description: string;
  strategy: AlgorithmStrategy;
  symbols: string[];
  maxLeverage: number;
  maxNotionalUsd: string;
  priceUsd: string;
  periodDays: number | null;
  isFeatured: boolean;
}

function toView(algorithm: TradingAlgorithm): AlgorithmView {
  return {
    slug: algorithm.slug,
    name: algorithm.name,
    description: algorithm.description,
    strategy: algorithm.strategy,
    symbols: algorithm.symbols,
    maxLeverage: algorithm.maxLeverage,
    maxNotionalUsd: algorithm.maxNotionalUsd,
    priceUsd: algorithm.priceUsd,
    periodDays: algorithm.periodDays,
    isFeatured: algorithm.isFeatured,
  };
}

/** The active catalog, featured first, cheapest next. */
export async function listAlgorithms(): Promise<AlgorithmView[]> {
  const rows = await prisma.tradingAlgorithm.findMany({
    where: { isActive: true },
    orderBy: [{ isFeatured: 'desc' }, { priceUsd: 'asc' }],
  });
  return rows.map(toView);
}

export async function getAlgorithmBySlug(slug: string): Promise<AlgorithmView | null> {
  const row = await prisma.tradingAlgorithm.findUnique({ where: { slug } });
  return row && row.isActive ? toView(row) : null;
}

// ── A participant's purchases ───────────────────────────────────────────────

export interface UserAlgorithmView {
  id: string;
  slug: string;
  name: string;
  status: AlgorithmStatus;
  pricePaidUsd: string;
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
    status: row.status,
    pricePaidUsd: row.pricePaidUsd,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    lastRunAt: row.lastRunAt,
  }));
}

/**
 * Buys an algorithm: debit the participant's balance, write (or reactivate) the
 * subscription, and record it.
 *
 * Reactivation rather than a second row: `(userId, algorithmId)` is one row for
 * the life of the relationship, so the runner can never pick up two
 * subscriptions for the same participant and strategy and place the order
 * twice. A re-purchase after a cancel brings the same row back to ACTIVE with
 * fresh dates and a fresh charge.
 */
export async function purchaseAlgorithm(
  user: User,
  slug: string,
  context: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<{ subscription: UserAlgorithm; algorithm: TradingAlgorithm }> {
  assertMayTrade(user);

  const algorithm = await prisma.tradingAlgorithm.findUnique({ where: { slug } });
  if (!algorithm || !algorithm.isActive) throw new NotFoundError('Algorithm');

  const price = new Decimal(algorithm.priceUsd);
  if (price.lessThanOrEqualTo(0)) {
    throw new ValidationError('This algorithm is not for sale');
  }

  const existing = await prisma.userAlgorithm.findFirst({
    where: { userId: user.id, algorithmId: algorithm.id },
  });
  if (existing?.status === AlgorithmStatus.ACTIVE) {
    throw new ValidationError(`${algorithm.name} is already running on your account.`);
  }

  /**
   * Sufficiency is checked here, before the debit, so an overdraw is a friendly
   * refusal rather than the ledger's raw sign CHECK surfacing as a 500.
   */
  const balance = await clientBalance(user.id, BILLING_ASSET);
  if (balance.available.lessThan(price)) {
    throw new ValidationError(
      `You need ${price.toFixed()} ${BILLING_ASSET} available to buy ${algorithm.name}.`,
      { price: price.toFixed(), available: balance.available.toFixed() },
    );
  }

  const id = existing?.id ?? newId();
  const reference = `algorithm-purchase:${id}`;
  const startsAt = new Date();
  const endsAt = algorithm.periodDays
    ? new Date(startsAt.getTime() + algorithm.periodDays * 86_400_000)
    : null;

  try {
    const subscription = await prisma.$transaction(async (tx) => {
      const available = await accountFor(
        { kind: LedgerAccountKind.USER_AVAILABLE, userId: user.id, asset: BILLING_ASSET },
        tx,
      );
      const revenue = await accountFor(
        { kind: LedgerAccountKind.FEE_REVENUE, asset: BILLING_ASSET },
        tx,
      );

      /**
       * Debit the participant (a liability, now owed that much less) and credit
       * FLT's revenue by the same amount. Two sides, summing to zero, with a
       * reference on (kind, reference) so a retried purchase cannot post twice.
       */
      await postTransfer(
        {
          kind: LedgerTransferKind.FEE,
          reference,
          memo: `Algorithm purchase: ${algorithm.name} (${algorithm.slug})`,
          entries: [
            { accountId: available.id, amount: price },
            { accountId: revenue.id, amount: price.negated() },
          ],
        },
        tx,
      );

      const data = {
        status: AlgorithmStatus.ACTIVE,
        pricePaidUsd: algorithm.priceUsd,
        ledgerReference: reference,
        startsAt,
        endsAt,
        cancelledAt: null,
        cancelReason: null,
        lastRunAt: null,
      };

      return existing
        ? tx.userAlgorithm.update({ where: { id }, data })
        : tx.userAlgorithm.create({
            data: { id, userId: user.id, algorithmId: algorithm.id, ...data },
          });
    });

    await audit(prisma, {
      action: AuditAction.ALGORITHM_PURCHASED,
      actorType: 'USER',
      actorUserId: user.id,
      entityType: 'user_algorithm',
      entityId: subscription.id,
      after: { algorithm: algorithm.slug, price: algorithm.priceUsd, ledgerReference: reference },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      requestId: context.requestId ?? null,
    });

    return { subscription, algorithm };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The ledger reference already posted — the purchase is already done.
      const row = await prisma.userAlgorithm.findFirstOrThrow({
        where: { userId: user.id, algorithmId: algorithm.id },
      });
      return { subscription: row, algorithm };
    }
    throw error;
  }
}

/**
 * Pauses, resumes or cancels a subscription.
 *
 * Cancel is terminal until re-purchased. It stops new orders only — it never
 * closes an open position, because an algorithm stopping is not a reason to
 * force an exit at whatever the market happens to be doing.
 */
export async function setAlgorithmStatus(
  user: User,
  id: string,
  status: AlgorithmStatus,
  reason?: string,
): Promise<UserAlgorithm> {
  const row = await prisma.userAlgorithm.findFirst({ where: { id, userId: user.id } });
  if (!row) throw new NotFoundError('Algorithm subscription');

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

// ── Strategy ────────────────────────────────────────────────────────────────

/**
 * Tunables a strategy reads. Deliberately loose: a value the strategy does not
 * know is ignored rather than fatal, so a catalog row can carry parameters for
 * a strategy added later without breaking the ones running now.
 */
export interface StrategyParams {
  /** Fast moving-average length (MA_CROSSOVER). */
  fast?: number;
  /** Slow moving-average length (MA_CROSSOVER). */
  slow?: number;
  /** Averaging window (MEAN_REVERSION). */
  window?: number;
  /** Bars back for the return (MOMENTUM). */
  lookback?: number;
  /** Minimum move, in basis points, before momentum fires. */
  thresholdBps?: number;
}

export function readStrategyParams(raw: unknown): StrategyParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as StrategyParams;
}

export interface SignalResult {
  /** The side the strategy wants to be on now. */
  side: 'LONG' | 'SHORT';
  /** A stable label recorded with the run, e.g. "MA_CROSSOVER_LONG". */
  signal: string;
}

/** Simple moving average, index-aligned so the last entry is the latest average. */
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

/**
 * Turns candles into a direction, or null for "no opinion".
 *
 * Pure and synchronous: no I/O, no clock, no position, no money. That is what
 * makes it testable and what keeps the risk checks in one place — this decides
 * *what* the strategy wants, and the runner decides whether it is *allowed*.
 * Null means the strategy is silent (not enough history, or a momentum filter
 * not met), which the runner treats as "hold".
 *
 * @param candles Oldest first, newest last (the venue's documented order).
 */
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
      // Fade the deviation: above the average is a short, below is a long.
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

/** Marks a subscription as evaluated now, driving its cadence. */
export async function touchAlgorithmRun(userAlgorithmId: string): Promise<void> {
  await prisma.userAlgorithm.update({
    where: { id: userAlgorithmId },
    data: { lastRunAt: new Date() },
  });
}

// ── Admin catalog management ────────────────────────────────────────────────

export interface AlgorithmWriteInput {
  slug: string;
  name: string;
  description: string;
  strategy: AlgorithmStrategy;
  params?: Record<string, unknown>;
  symbols: string[];
  maxLeverage: number;
  maxNotionalUsd: string;
  priceUsd: string;
  periodDays?: number | null;
  isActive?: boolean;
  isFeatured?: boolean;
}

/** The full catalog for the admin panel, active and inactive alike. */
export async function listAllAlgorithms(): Promise<TradingAlgorithm[]> {
  return prisma.tradingAlgorithm.findMany({
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function createAlgorithm(
  admin: AdminUser,
  input: AlgorithmWriteInput,
): Promise<TradingAlgorithm> {
  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{2,64}$/.test(slug)) {
    throw new ValidationError(
      'Slug must be 2–64 characters of lowercase letters, digits or dashes',
    );
  }
  if (input.symbols.length === 0) {
    throw new ValidationError('An algorithm needs at least one symbol');
  }

  const existing = await prisma.tradingAlgorithm.findUnique({ where: { slug } });
  if (existing) {
    throw new ConflictError(
      'ALGORITHM_EXISTS',
      `An algorithm with the slug "${slug}" already exists.`,
    );
  }

  const row = await prisma.tradingAlgorithm.create({
    data: {
      id: newId(),
      slug,
      name: input.name.trim(),
      description: input.description.trim(),
      strategy: input.strategy,
      params: (input.params ?? {}) as Prisma.InputJsonValue,
      symbols: input.symbols,
      maxLeverage: input.maxLeverage,
      maxNotionalUsd: input.maxNotionalUsd,
      priceUsd: input.priceUsd,
      periodDays: input.periodDays ?? null,
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
    after: { created: row.slug, priceUsd: row.priceUsd, isActive: row.isActive },
  });

  return row;
}

export async function updateAlgorithm(
  admin: AdminUser,
  id: string,
  input: Partial<AlgorithmWriteInput>,
): Promise<TradingAlgorithm> {
  const existing = await prisma.tradingAlgorithm.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Algorithm');

  const data: Prisma.TradingAlgorithmUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.description !== undefined) data.description = input.description.trim();
  if (input.strategy !== undefined) data.strategy = input.strategy;
  if (input.params !== undefined) data.params = input.params as Prisma.InputJsonValue;
  if (input.symbols !== undefined) {
    if (input.symbols.length === 0) {
      throw new ValidationError('An algorithm needs at least one symbol');
    }
    data.symbols = input.symbols;
  }
  if (input.maxLeverage !== undefined) data.maxLeverage = input.maxLeverage;
  if (input.maxNotionalUsd !== undefined) data.maxNotionalUsd = input.maxNotionalUsd;
  if (input.priceUsd !== undefined) data.priceUsd = input.priceUsd;
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
    before: { isActive: existing.isActive, priceUsd: existing.priceUsd },
    after: { isActive: row.isActive, priceUsd: row.priceUsd },
  });

  return row;
}