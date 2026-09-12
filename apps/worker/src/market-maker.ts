import { isUniqueViolation, prisma } from '@flt/db';
import { env } from '@flt/config';
import { Decimal, newId } from '@flt/core/domain';
import { planRequote } from '@flt/core/marketmaking/runner';
import { bookMakerPnl } from '@flt/core/services/market-maker-ledger';
import { distributeResult } from '@flt/core/services/passive-cash';
import { HistoricalStdDev, toDailySigma } from '@flt/core/protection/volatility';
import {
  cancelMakerOrders,
  perpVenue,
  placeMakerQuotes,
  readMakerFills,
  readMakerOpenOrders,
  readMakerPositions,
} from '@flt/providers';

/**
 * The market-making worker pass (docs/adr/0007).
 *
 * One cycle: ingest fills, read the venue, decide (the pure `planRequote`), and
 * apply — cancel what is stale, place the ladder, or halt. It holds no policy of
 * its own beyond orchestration; the decision lives in core, the signing in
 * providers, and the ledger movements in the ledger service.
 *
 * Safe to repeat: fills dedup on the venue trade id, price/PnL booking is
 * idempotent on a reference, and the loop never overlaps itself.
 */

export interface MarketMakerPassResult {
  placed: number;
  cancelled: number;
  fills: number;
  halted: boolean;
}

const ZERO: MarketMakerPassResult = { placed: 0, cancelled: 0, fills: 0, halted: false };

function startOfUtcDay(): Date {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

async function loadConfig() {
  return prisma.marketMakerConfig.findUnique({
    where: { venueSlug_symbol: { venueSlug: env().MM_VENUE_SLUG, symbol: env().MM_SYMBOL } },
  });
}

/**
 * Ingests the venue's recent fills and books each new one against FLT equity.
 *
 * Idempotent twice over: a fill already in `maker_fills` is skipped (unique on
 * venue trade id), and the ledger booking is keyed `maker-fill:<tid>`, so a
 * crash between the two is recovered on the next pass without double-posting.
 */
async function ingestFills(configId: string, symbol: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const fills = await readMakerFills(since);

  let ingested = 0;
  for (const fill of fills) {
    if (fill.symbol !== symbol) continue;

    try {
      await prisma.makerFill.create({
        data: {
          id: newId(),
          configId,
          venueSlug: env().MM_VENUE_SLUG,
          symbol,
          venueOid: fill.venueOid,
          cloid: null,
          venueTid: fill.venueTid,
          venueHash: fill.venueHash,
          isBuy: fill.isBuy,
          price: fill.price,
          size: fill.size,
          feeUsd: fill.feeUsd,
          closedPnlUsd: fill.closedPnlUsd,
          filledAt: fill.filledAt,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) continue; // already ingested
      throw error;
    }

    // The fill's economic result: realized PnL minus the venue fee. A purely
    // opening add has closedPnl 0 and a fee, so its cost is booked too.
    const net = new Decimal(fill.closedPnlUsd).minus(fill.feeUsd);
    await bookMakerPnl({ pnl: net, reference: `maker-fill:${fill.venueTid}` });
    ingested += 1;
  }

  return ingested;
}

/** The book's realized result so far today, net of fees — what the kill switch reads. */
async function realizedNetToday(configId: string): Promise<Decimal> {
  const rows = await prisma.makerFill.findMany({
    where: { configId, filledAt: { gte: startOfUtcDay() } },
    select: { closedPnlUsd: true, feeUsd: true },
  });
  return rows.reduce(
    (sum, row) => sum.plus(new Decimal(row.closedPnlUsd)).minus(new Decimal(row.feeUsd)),
    new Decimal(0),
  );
}

/** Daily volatility, as the fraction the ladder widens by. Zero if unavailable. */
async function estimateVolatility(symbol: string): Promise<Decimal> {
  try {
    const candles = await perpVenue().getCandles(symbol, '1h', 400);
    if (candles.length > 100) {
      const estimate = new HistoricalStdDev().calculate(candles, candles.length, 1 / 24);
      return toDailySigma(estimate);
    }
  } catch (error) {
    console.error('[mm] volatility estimate failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return new Decimal(0);
}

/** Pulls every resting quote — the flatten the kill switch calls for. */
async function cancelAll(open: Awaited<ReturnType<typeof readMakerOpenOrders>>, symbol: string): Promise<number> {
  if (open.length === 0) return 0;
  await cancelMakerOrders(open.map((order) => ({ symbol, cloid: order.cloid ?? undefined, oid: order.oid })));
  return open.length;
}

async function distributeIfEnabled(configId: string, since: Date | null): Promise<void> {
  const rows = await prisma.makerFill.findMany({
    where: { configId, filledAt: { gte: since ?? startOfUtcDay() } },
    select: { closedPnlUsd: true, feeUsd: true },
  });
  const net = rows.reduce(
    (sum, row) => sum.plus(new Decimal(row.closedPnlUsd)).minus(new Decimal(row.feeUsd)),
    new Decimal(0),
  );
  if (net.isZero()) return;

  await distributeResult({ netResult: net.toFixed(), reason: 'market-making cycle' });
  await prisma.marketMakerConfig.update({
    where: { id: configId },
    data: { lastDistributedAt: new Date() },
  });
}

export async function runMarketMakerPass(): Promise<MarketMakerPassResult> {
  const config = await loadConfig();
  if (!config || !config.isEnabled) return ZERO;

  // Honor the configured cadence even if the loop ticks faster.
  if (config.lastRunAt && Date.now() - config.lastRunAt.getTime() < config.requoteMs) return ZERO;

  const symbol = config.symbol;
  const fills = await ingestFills(config.id, symbol);

  const [open, positions, market] = await Promise.all([
    readMakerOpenOrders(),
    readMakerPositions(),
    perpVenue().getMarket(symbol),
  ]);

  if (!market?.markPrice) {
    console.error('[mm] venue did not report a mark price', { symbol });
    return { ...ZERO, fills };
  }

  // A persisted halt stays flat: cancel whatever rests and quote nothing.
  if (config.halted) {
    const cancelled = await cancelAll(open, symbol);
    await prisma.marketMakerConfig.update({ where: { id: config.id }, data: { lastRunAt: new Date() } });
    return { placed: 0, cancelled, fills, halted: true };
  }

  const position = positions.find((p) => p.symbol === symbol);
  const inventory = position
    ? new Decimal(position.size).times(position.side === 'LONG' ? 1 : -1)
    : new Decimal(0);
  const realizedToday = await realizedNetToday(config.id);
  const volatility = await estimateVolatility(symbol);

  const plan = planRequote({
    symbol,
    config: {
      halfSpreadBps: config.halfSpreadBps,
      levels: config.levels,
      levelSize: config.levelSize,
      levelStepBps: config.levelStepBps,
      maxInventory: config.maxInventory,
      maxDailyLossUsd: config.maxDailyLossUsd,
    },
    state: {
      midPrice: market.markPrice,
      volatility: volatility.toFixed(),
      inventory: inventory.toFixed(),
      realizedPnlTodayUsd: realizedToday.toFixed(),
      openOrders: open.map((order) => ({
        cloid: order.cloid ?? '',
        isBuy: order.isBuy,
        price: order.price,
        size: order.size,
      })),
    },
  });

  if (plan.halt) {
    const cancelled = await cancelAll(open, symbol);
    await prisma.marketMakerConfig.update({
      where: { id: config.id },
      data: { halted: true, haltedReason: plan.halt.reason, haltedAt: new Date(), lastRunAt: new Date() },
    });
    console.error('[mm] halted', { reason: plan.halt.reason });
    return { placed: 0, cancelled, fills, halted: true };
  }

  let cancelled = 0;
  if (plan.cancel.length > 0) {
    await cancelMakerOrders(plan.cancel.map((cancel) => ({ symbol: cancel.symbol, cloid: cancel.cloid })));
    cancelled = plan.cancel.length;
  }

  let placed = 0;
  if (plan.place.length > 0) {
    const result = await placeMakerQuotes(plan.place);
    placed = result.oids.length;
  }

  // Passive cash is gated off (ADR 0007 §5): this only runs when an operator has
  // deliberately enabled it, and then only moves realized results, never capital.
  if (env().PASSIVE_CASH_ENABLED) {
    await distributeIfEnabled(config.id, config.lastDistributedAt).catch((error) => {
      console.error('[mm] distribution failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  await prisma.marketMakerConfig.update({ where: { id: config.id }, data: { lastRunAt: new Date() } });
  return { placed, cancelled, fills, halted: false };
}
