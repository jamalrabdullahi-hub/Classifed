import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { Decimal } from '../domain/money';
import { newId } from '../domain/id';
import { NotFoundError, ValidationError } from '../domain/errors';
import { AuditAction } from './audit';
import { PERMISSIONS, assertCan, recordAdminAction, type AdminActionContext } from './admin';

/**
 * Operator control of FLT's market-making book (docs/adr/0007).
 *
 * The book is off until an operator turns it on and can be halted without a
 * deploy — the kill switch is a column, and this is what writes it. Every
 * change is a recorded admin action with a reason, because "who turned the
 * automated book on" is a question someone will ask.
 *
 * Deliberately narrow: it controls *whether* the book runs and what caps it
 * runs under, never a specific quote. The runner decides those; an operator
 * steering a live ladder by hand is exactly the manual trading this is not.
 */

function configKey(): { venueSlug: string; symbol: string } {
  return { venueSlug: env().MM_VENUE_SLUG, symbol: env().MM_SYMBOL };
}

export interface MarketMakerStatus {
  config: Awaited<ReturnType<typeof prisma.marketMakerConfig.findUnique>> | null;
  realizedTodayUsd: string;
  recentFills: Array<{
    id: string;
    symbol: string;
    isBuy: boolean;
    price: string;
    size: string;
    feeUsd: string;
    closedPnlUsd: string;
    filledAt: Date;
  }>;
}

export async function getMarketMakerConfig() {
  const { venueSlug, symbol } = configKey();
  return prisma.marketMakerConfig.findUnique({ where: { venueSlug_symbol: { venueSlug, symbol } } });
}

async function requireConfig() {
  const config = await getMarketMakerConfig();
  if (!config) throw new NotFoundError('Market-maker configuration');
  return config;
}

export async function marketMakerStatus(): Promise<MarketMakerStatus> {
  const config = await getMarketMakerConfig();
  if (!config) return { config: null, realizedTodayUsd: '0', recentFills: [] };

  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);

  const fills = await prisma.makerFill.findMany({
    where: { configId: config.id, filledAt: { gte: day } },
    orderBy: { filledAt: 'desc' },
    take: 50,
  });

  const realized = fills.reduce(
    (sum, fill) => sum.plus(new Decimal(fill.closedPnlUsd)).minus(new Decimal(fill.feeUsd)),
    new Decimal(0),
  );

  return {
    config,
    realizedTodayUsd: realized.toFixed(),
    recentFills: fills.map((fill) => ({
      id: fill.id,
      symbol: fill.symbol,
      isBuy: fill.isBuy,
      price: fill.price,
      size: fill.size,
      feeUsd: fill.feeUsd,
      closedPnlUsd: fill.closedPnlUsd,
      filledAt: fill.filledAt,
    })),
  };
}

export interface MarketMakerConfigInput {
  halfSpreadBps: number;
  levels: number;
  levelSize: string;
  levelStepBps: number;
  maxInventory: string;
  maxDailyLossUsd: string;
  requoteMs: number;
  reason: string;
}

/** Creates or re-caps the book's configuration. Does not enable it. */
export async function upsertMarketMakerConfig(
  ctx: AdminActionContext,
  input: MarketMakerConfigInput,
): Promise<void> {
  assertCan(ctx.admin, PERMISSIONS.MANAGE_MARKET_MAKING);
  if (!input.reason.trim()) throw new ValidationError('A reason is required');

  const levelSize = new Decimal(input.levelSize);
  const maxInventory = new Decimal(input.maxInventory);
  if (!levelSize.isFinite() || levelSize.lessThanOrEqualTo(0)) {
    throw new ValidationError('Level size must be a positive number');
  }
  if (!maxInventory.isFinite() || maxInventory.lessThanOrEqualTo(0)) {
    throw new ValidationError('Max inventory must be a positive number');
  }
  if (input.levels < 1 || input.levels > 20) {
    throw new ValidationError('Levels must be between 1 and 20');
  }

  const { venueSlug, symbol } = configKey();
  const existing = await prisma.marketMakerConfig.findUnique({
    where: { venueSlug_symbol: { venueSlug, symbol } },
  });

  const data = {
    halfSpreadBps: input.halfSpreadBps,
    levels: input.levels,
    levelSize: levelSize.toFixed(),
    levelStepBps: input.levelStepBps,
    maxInventory: maxInventory.toFixed(),
    maxDailyLossUsd: input.maxDailyLossUsd,
    requoteMs: input.requoteMs,
  };

  const saved = existing
    ? await prisma.marketMakerConfig.update({ where: { id: existing.id }, data })
    : await prisma.marketMakerConfig.create({ data: { id: newId(), venueSlug, symbol, ...data } });

  await recordAdminAction(prisma, ctx, {
    action: AuditAction.MARKET_MAKER_UPDATED,
    entityType: 'market_maker_config',
    entityId: saved.id,
    before: existing
      ? { halfSpreadBps: existing.halfSpreadBps, levels: existing.levels, levelSize: existing.levelSize }
      : null,
    after: data,
    reason: input.reason,
  });
}

/** Turns the book on or off. Off cancels nothing by itself — the next pass does. */
export async function setMarketMakerEnabled(
  ctx: AdminActionContext,
  enabled: boolean,
  reason: string,
): Promise<void> {
  assertCan(ctx.admin, PERMISSIONS.MANAGE_MARKET_MAKING);
  if (!reason.trim()) throw new ValidationError('A reason is required');

  const config = await requireConfig();
  const saved = await prisma.marketMakerConfig.update({
    where: { id: config.id },
    data: { isEnabled: enabled },
  });

  await recordAdminAction(prisma, ctx, {
    action: enabled ? AuditAction.MARKET_MAKER_ENABLED : AuditAction.MARKET_MAKER_DISABLED,
    entityType: 'market_maker_config',
    entityId: saved.id,
    before: { isEnabled: config.isEnabled },
    after: { isEnabled: enabled },
    reason,
  });
}

/** The kill switch: halt flattens the book on the next pass; resume re-enables. */
export async function setMarketMakerHalt(
  ctx: AdminActionContext,
  halted: boolean,
  reason: string,
): Promise<void> {
  assertCan(ctx.admin, PERMISSIONS.MANAGE_MARKET_MAKING);
  if (!reason.trim()) throw new ValidationError('A reason is required');

  const config = await requireConfig();
  const saved = await prisma.marketMakerConfig.update({
    where: { id: config.id },
    data: {
      halted,
      haltedReason: halted ? reason.trim() : null,
      haltedAt: halted ? new Date() : null,
    },
  });

  await recordAdminAction(prisma, ctx, {
    action: halted ? AuditAction.MARKET_MAKER_HALTED : AuditAction.MARKET_MAKER_RESUMED,
    entityType: 'market_maker_config',
    entityId: saved.id,
    before: { halted: config.halted },
    after: { halted },
    reason,
  });
}
