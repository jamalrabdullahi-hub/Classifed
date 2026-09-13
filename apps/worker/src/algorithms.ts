import { AlgorithmKind, AlgorithmStatus, PerpOrderKind, prisma, type TradingAlgorithm, type UserAlgorithm } from '@flt/db';
import { env } from '@flt/config';
import { Decimal, DomainError } from '@flt/core/domain';
import { AuditAction, audit } from '@flt/core/services/audit';
import {
  accrueAlgorithmFees,
  computeSignal,
  readStrategyParams,
  recordAlgorithmRun,
  settleDueAlgorithmFees,
  touchAlgorithmRun,
  type SignalResult,
} from '@flt/core/services';
import { resolveTradingWallet } from '@flt/core/services/wallets';
import { resolveOfferedMarket } from '@flt/core/services/perps';
import {
  assertDailyTradesRemaining,
  assertLeverageAllowed,
  assertPerpsAllowed,
  entitlementsFor,
  startOfUtcDay,
} from '@flt/core/services/entitlements';
import { contractsForUsd } from '@flt/core/protection';
import {
  aiProvider,
  closeCustodyPerpOrder,
  openCustodyPerpPosition,
  perpVenues,
  type AiMarketSnapshot,
  type PerpVenue,
} from '@flt/providers';

/**
 * Automated-trading execution.
 *
 * Runs both offerings. **Algo** evaluates a deterministic strategy over the
 * candles; **AI** hands a compact market snapshot and the participant's prompt
 * to the model and acts on the single decision it returns. Either way the order
 * goes through `openCustodyPerpPosition` — the same function the manual ticket
 * calls — so the participant's margin is reserved on the ledger, the insurance
 * requirement is enforced, and the order is attributed and auditable exactly as
 * a hand-placed one. On top of that this pass applies the plan limits, the daily
 * allowance, and the offering's notional and leverage caps.
 *
 * The AI decides *direction* and nothing else. It cannot size an order, bypass
 * a check, or touch funds.
 */

const CANDLE_INTERVAL = '1h' as const;
const CANDLE_LIMIT = 200;
/** How many recent closes to include in an AI snapshot. */
const AI_SNAPSHOT_BARS = 48;
const MIN_RERUN_MS = 60 * 60_000;

export interface AlgorithmRunResult {
  considered: number;
  opened: number;
  closed: number;
  refused: number;
  failures: number;
}

/**
 * Accrues management fees and settles any full period due. Cheap, so it runs on
 * the same cadence as the runner.
 */
export async function runAlgorithmFees(): Promise<{ accrued: number; settled: number }> {
  if (!env().ALGORITHMS_ENABLED) return { accrued: 0, settled: 0 };
  const { accrued } = await accrueAlgorithmFees();
  const { settled } = await settleDueAlgorithmFees();
  return { accrued, settled };
}

export async function runAlgorithmPass(): Promise<AlgorithmRunResult> {
  const result: AlgorithmRunResult = {
    considered: 0,
    opened: 0,
    closed: 0,
    refused: 0,
    failures: 0,
  };

  const config = env();
  if (!config.ALGORITHMS_ENABLED || !config.PERPS_ENABLED) return result;

  const now = new Date();
  const due = await prisma.userAlgorithm.findMany({
    where: {
      status: AlgorithmStatus.ACTIVE,
      OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(now.getTime() - MIN_RERUN_MS) } }],
    },
    include: { algorithm: true },
    orderBy: { lastRunAt: { sort: 'asc', nulls: 'first' } },
    take: 100,
  });

  result.considered = due.length;
  if (due.length === 0) return result;

  const venues = perpVenues();

  for (const subscription of due) {
    try {
      const outcome =
        subscription.algorithm.kind === AlgorithmKind.AI
          ? await runAiSubscription(subscription, subscription.algorithm, venues)
          : await runAlgoSubscription(subscription, subscription.algorithm, venues);
      result.opened += outcome.opened;
      result.closed += outcome.closed;
      result.refused += outcome.refused;
      await touchAlgorithmRun(subscription.id);
    } catch (error) {
      result.failures += 1;
      console.error('[algorithms] subscription failed', {
        userAlgorithmId: subscription.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

// ── Algo (deterministic) ────────────────────────────────────────────────────

async function runAlgoSubscription(
  subscription: UserAlgorithm,
  algorithm: TradingAlgorithm,
  venues: PerpVenue[],
): Promise<{ opened: number; closed: number; refused: number }> {
  const summary = { opened: 0, closed: 0, refused: 0 };
  const params = readStrategyParams(subscription.strategyParams ?? algorithm.params);

  const pre = await prepareAccount(subscription.userId);
  if (!pre) throw new Error('account not ready');

  for (const rawSymbol of algorithm.symbols) {
    const offered = await resolveOfferedMarket(venues, rawSymbol);
    if (!offered) continue;
    const { venue, row, market } = offered;

    const candles = await venue.getCandles(market.symbol, CANDLE_INTERVAL, CANDLE_LIMIT);
    const signal = computeSignal(algorithm.strategy, params, candles);
    if (!signal) continue;

    await act(subscription, algorithm, pre, {
      marketId: row.id,
      symbol: market.symbol,
      maxLeverage: market.maxLeverage,
      markPrice: market.markPrice,
      sizeDecimals: market.sizeDecimals,
      signal,
    }, summary);
  }

  return summary;
}

// ── AI ──────────────────────────────────────────────────────────────────────

async function runAiSubscription(
  subscription: UserAlgorithm,
  algorithm: TradingAlgorithm,
  venues: PerpVenue[],
): Promise<{ opened: number; closed: number; refused: number }> {
  const summary = { opened: 0, closed: 0, refused: 0 };
  const pre = await prepareAccount(subscription.userId);
  if (!pre) throw new Error('account not ready');

  const markets: AiMarketSnapshot[] = [];
  const resolved = new Map<
    string,
    { marketId: string; maxLeverage: number; markPrice: string | null; sizeDecimals: number }
  >();

  for (const rawSymbol of algorithm.symbols) {
    const offered = await resolveOfferedMarket(venues, rawSymbol);
    if (!offered) continue;
    const { venue, row, market } = offered;

    const candles = await venue.getCandles(market.symbol, CANDLE_INTERVAL, CANDLE_LIMIT);
    const closes = candles.slice(-AI_SNAPSHOT_BARS).map((candle) => candle.close);
    const dayAgo = candles[candles.length - 25]?.close;
    const last = closes[closes.length - 1];
    const currentSide = await currentSideFor(subscription.userId, row.id);

    markets.push({
      symbol: market.symbol,
      markPrice: market.markPrice,
      change24hPct:
        dayAgo && last && dayAgo !== 0 ? (((last - dayAgo) / dayAgo) * 100).toFixed(2) : null,
      closes,
      currentSide,
    });
    resolved.set(market.symbol, {
      marketId: row.id,
      maxLeverage: market.maxLeverage,
      markPrice: market.markPrice,
      sizeDecimals: market.sizeDecimals,
    });
  }

  if (markets.length === 0) return summary;

  let decision;
  try {
    decision = await (await aiProvider()).decide({
      systemPrompt: algorithm.systemPrompt,
      userPrompt: subscription.prompt ?? 'Trade prudently.',
      allowedSymbols: algorithm.symbols,
      maxLeverage: algorithm.maxLeverage,
      markets,
    });
  } catch (error) {
    summary.refused += 1;
    await recordAlgorithmRun({
      userAlgorithmId: subscription.id,
      symbol: markets[0]!.symbol,
      side: 'LONG',
      signal: 'AI_ERROR',
      status: 'refused',
      reason: error instanceof DomainError ? error.code : 'AI_ERROR',
    });
    return summary;
  }

  const target = decision.symbol ? resolved.get(decision.symbol) : undefined;

  if (decision.action === 'HOLD' || !target || !decision.symbol) {
    return summary;
  }

  const holding = markets.find((m) => m.symbol === decision.symbol)?.currentSide ?? null;

  if (decision.action === 'CLOSE') {
    if (!holding) return summary;
    await closePosition(subscription, target.marketId, decision.symbol, holding, summary, decision.rationale);
    return summary;
  }

  // OPEN_LONG / OPEN_SHORT — only if it changes the position.
  const side: 'LONG' | 'SHORT' = decision.action === 'OPEN_LONG' ? 'LONG' : 'SHORT';
  if (holding === side) return summary;

  await act(
    subscription,
    algorithm,
    pre,
    {
      marketId: target.marketId,
      symbol: decision.symbol,
      maxLeverage: target.maxLeverage,
      markPrice: target.markPrice,
      sizeDecimals: target.sizeDecimals,
      signal: { side, signal: `AI_${decision.action}` },
    },
    summary,
    decision.rationale,
  );

  return summary;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

interface PreparedAccount {
  walletId: string;
  entitlements: Awaited<ReturnType<typeof entitlementsFor>>;
}

async function prepareAccount(userId: string): Promise<PreparedAccount | null> {
  const entitlements = await entitlementsFor(userId);
  assertPerpsAllowed(entitlements);
  const wallet = await resolveTradingWallet(prisma, userId);
  return { walletId: wallet.id, entitlements };
}

async function currentSideFor(userId: string, marketId: string): Promise<'LONG' | 'SHORT' | null> {
  const lastOrder = await prisma.perpOrder.findFirst({
    where: { userId, marketId },
    orderBy: { id: 'desc' },
  });
  return lastOrder?.kind === PerpOrderKind.OPEN ? (lastOrder.side as 'LONG' | 'SHORT') : null;
}

interface ActTarget {
  marketId: string;
  symbol: string;
  maxLeverage: number;
  markPrice: string | null;
  sizeDecimals: number;
  signal: SignalResult;
}

/**
 * Opens (or flips) a position per the signal, under every guard. A flip closes
 * first — the next pass opens the other side, since settlement is on the fill.
 */
async function act(
  subscription: UserAlgorithm,
  algorithm: TradingAlgorithm,
  pre: PreparedAccount,
  target: ActTarget,
  summary: { opened: number; closed: number; refused: number },
  reason?: string,
): Promise<void> {
  const holding = await currentSideFor(subscription.userId, target.marketId);

  if (holding && holding !== target.signal.side) {
    await closePosition(subscription, target.marketId, target.symbol, holding, summary, reason);
    return;
  }
  if (holding === target.signal.side) return;

  const leverage = Math.max(
    1,
    Math.min(algorithm.maxLeverage, pre.entitlements.maxLeverage, target.maxLeverage),
  );

  const openedToday = await prisma.perpOrder.count({
    where: {
      userId: subscription.userId,
      kind: PerpOrderKind.OPEN,
      submittedAt: { gte: startOfUtcDay() },
    },
  });

  try {
    assertDailyTradesRemaining(pre.entitlements, openedToday);
    assertLeverageAllowed(pre.entitlements, leverage);
    if (!target.markPrice) return;

    const size = contractsForUsd(
      new Decimal(algorithm.maxNotionalUsd),
      new Decimal(target.markPrice),
      target.sizeDecimals,
    ).toFixed();

    const opened = await openCustodyPerpPosition({
      userId: subscription.userId,
      walletId: pre.walletId,
      marketId: target.marketId,
      intent: {
        symbol: target.symbol,
        side: target.signal.side,
        size,
        leverage,
        marginMode: 'ISOLATED',
        limitPrice: null,
        slippageBps: 100,
        reduceOnly: false,
        orderType: 'MARKET',
      },
    });

    await recordAlgorithmRun({
      userAlgorithmId: subscription.id,
      symbol: target.symbol,
      side: target.signal.side,
      signal: target.signal.signal,
      perpOrderId: opened.orderId,
      status: 'opened',
    });
    await audit(prisma, {
      action: AuditAction.ALGORITHM_ORDER_PLACED,
      actorType: 'SYSTEM',
      actorUserId: subscription.userId,
      entityType: 'user_algorithm',
      entityId: subscription.id,
      after: { action: 'open', symbol: target.symbol, side: target.signal.side, leverage, size, signal: target.signal.signal, reason: reason ?? null },
    });
    summary.opened += 1;
  } catch (error) {
    summary.refused += 1;
    const code = error instanceof DomainError ? error.code : 'ERROR';
    await recordAlgorithmRun({
      userAlgorithmId: subscription.id,
      symbol: target.symbol,
      side: target.signal.side,
      signal: target.signal.signal,
      status: 'refused',
      reason: code,
    });
    await audit(prisma, {
      action: AuditAction.ALGORITHM_ORDER_REFUSED,
      actorType: 'SYSTEM',
      actorUserId: subscription.userId,
      entityType: 'user_algorithm',
      entityId: subscription.id,
      after: { symbol: target.symbol, code, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function closePosition(
  subscription: UserAlgorithm,
  marketId: string,
  symbol: string,
  holding: 'LONG' | 'SHORT',
  summary: { opened: number; closed: number; refused: number },
  reason?: string,
): Promise<void> {
  const lastOrder = await prisma.perpOrder.findFirst({
    where: { userId: subscription.userId, marketId },
    orderBy: { id: 'desc' },
  });
  const margin = new Decimal(lastOrder?.marginRequired ?? '0');
  const wallet = await resolveTradingWallet(prisma, subscription.userId);

  await closeCustodyPerpOrder({
    userId: subscription.userId,
    walletId: wallet.id,
    marketId,
    symbol,
    margin,
  });
  await recordAlgorithmRun({
    userAlgorithmId: subscription.id,
    symbol,
    side: holding,
    signal: `CLOSE_${holding}`,
    status: 'closed',
  });
  await audit(prisma, {
    action: AuditAction.ALGORITHM_ORDER_PLACED,
    actorType: 'SYSTEM',
    actorUserId: subscription.userId,
    entityType: 'user_algorithm',
    entityId: subscription.id,
    after: { action: 'close', symbol, reason: reason ?? null },
  });
  summary.closed += 1;
}
