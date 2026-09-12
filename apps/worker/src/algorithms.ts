import { AlgorithmStatus, PerpOrderKind, prisma } from '@flt/db';
import { env } from '@flt/config';
import { Decimal, DomainError } from '@flt/core/domain';
import { AuditAction, audit } from '@flt/core/services/audit';
import {
  computeSignal,
  readStrategyParams,
  recordAlgorithmRun,
  touchAlgorithmRun,
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
  closeCustodyPerpOrder,
  openCustodyPerpPosition,
  perpVenues,
  type PerpVenue,
} from '@flt/providers';
import type { UserAlgorithm, TradingAlgorithm } from '@flt/db';

/**
 * Algorithm execution.
 *
 * The one worker pass that places orders on a participant's behalf. It reads
 * candles, asks the strategy for a direction, and — only if the participant's
 * records say they are not already positioned as the strategy wants — places an
 * order through the ordinary custody path.
 *
 * ## Everything is borrowed, nothing is bypassed
 *
 * The order goes through `openCustodyPerpPosition`, the same function the manual
 * ticket calls. So the participant's margin is reserved on the ledger, the
 * insurance requirement is enforced (`assertLeveragedCover` runs inside it), and
 * the order is attributed and auditable exactly as a hand-placed one. On top of
 * that this pass applies the subscription's own limits — plan leverage, the
 * daily trade allowance, the algorithm's notional and leverage caps — before
 * calling anything.
 *
 * ## Attribution on a pooled venue account
 *
 * Under custody every participant's position sits on the omnibus's single venue
 * account, so the venue cannot tell us whose position is whose. Our own
 * `PerpOrder` rows are the attribution source: the most recent OPEN for
 * (user, market) with no CLOSE after it means the participant is positioned.
 *
 * ## Conservative by construction
 *
 * The pass is off unless ALGORITHMS_ENABLED is set, it never re-evaluates a
 * subscription more often than the bar it reads, and a refusal (no insurance, no
 * balance, over the daily limit) is recorded and skipped rather than retried in
 * a tight loop. It never opens a 1x position it cannot cover and it never
 * touches an account it cannot attribute an order to.
 */

/** The bar the strategies read. Matches the throttle below. */
const CANDLE_INTERVAL = '1h' as const;
const CANDLE_LIMIT = 200;

/**
 * Do not re-evaluate one subscription more often than the bar it trades.
 *
 * The venue works on hourly bars, so acting more than once an hour on the same
 * signal cannot change the decision — it can only spend rate limit and, on a
 * flapping signal, churn the position.
 */
const MIN_RERUN_MS = 60 * 60_000;

export interface AlgorithmRunResult {
  considered: number;
  evaluated: number;
  opened: number;
  closed: number;
  refused: number;
  failures: number;
}

export async function runAlgorithmPass(): Promise<AlgorithmRunResult> {
  const result: AlgorithmRunResult = {
    considered: 0,
    evaluated: 0,
    opened: 0,
    closed: 0,
    refused: 0,
    failures: 0,
  };

  const config = env();
  if (!config.ALGORITHMS_ENABLED || !config.PERPS_ENABLED) return result;

  const now = new Date();

  // Retire anything whose paid period has lapsed before it can trade again.
  await prisma.userAlgorithm.updateMany({
    where: { status: AlgorithmStatus.ACTIVE, endsAt: { lte: now } },
    data: { status: AlgorithmStatus.EXPIRED },
  });

  const due = await prisma.userAlgorithm.findMany({
    where: {
      status: AlgorithmStatus.ACTIVE,
      OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(now.getTime() - MIN_RERUN_MS) } }],
    },
    include: { algorithm: true },
    // Oldest evaluation first, so a burst of purchases drains fairly.
    orderBy: { lastRunAt: { sort: 'asc', nulls: 'first' } },
    take: 100,
  });

  result.considered = due.length;
  if (due.length === 0) return result;

  const venues = perpVenues();

  for (const subscription of due) {
    try {
      const outcome = await evaluateSubscription(subscription, subscription.algorithm, venues);
      result.evaluated += 1;
      result.opened += outcome.opened;
      result.closed += outcome.closed;
      result.refused += outcome.refused;
      await touchAlgorithmRun(subscription.id);
    } catch (error) {
      // One subscription failing must not stop the pass. A refusal it can act on
      // is recorded by the caller; anything thrown here is unexpected and logged.
      result.failures += 1;
      console.error('[algorithms] subscription failed', {
        userAlgorithmId: subscription.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function evaluateSubscription(
  subscription: UserAlgorithm,
  algorithm: TradingAlgorithm,
  venues: PerpVenue[],
): Promise<{ opened: number; closed: number; refused: number }> {
  const params = readStrategyParams(algorithm.params);
  const summary = { opened: 0, closed: 0, refused: 0 };

  // Refuse the whole subscription if the account may not trade perps at all.
  // A Free tier with no perps access should not silently no-op per symbol.
  const entitlements = await entitlementsFor(subscription.userId);
  assertPerpsAllowed(entitlements);

  const wallet = await resolveTradingWallet(prisma, subscription.userId);

  for (const rawSymbol of algorithm.symbols) {
    const offered = await resolveOfferedMarket(venues, rawSymbol);
    if (!offered) continue;
    const { venue, row, market } = offered;

    const candles = await venue.getCandles(market.symbol, CANDLE_INTERVAL, CANDLE_LIMIT);
    const signal = computeSignal(algorithm.strategy, params, candles);
    if (!signal) continue;

    // Our records say what the participant holds on this market.
    const lastOrder = await prisma.perpOrder.findFirst({
      where: { userId: subscription.userId, marketId: row.id },
      // UUIDv7 ids are time-ordered, so the greatest id is the newest order.
      orderBy: { id: 'desc' },
    });
    const holding =
      lastOrder?.kind === PerpOrderKind.OPEN ? (lastOrder.side as 'LONG' | 'SHORT') : null;

    // Already positioned the way the strategy wants: nothing to do.
    if (holding === signal.side) continue;

    if (holding && holding !== signal.side) {
      // Flip: close the existing position first. The next pass will open the
      // other side; doing both in one pass would need the close to settle, and
      // settlement happens on the fill, not the request.
      const margin = new Decimal(lastOrder?.marginRequired ?? '0');
      await closeCustodyPerpOrder({
        userId: subscription.userId,
        walletId: wallet.id,
        marketId: row.id,
        symbol: market.symbol,
        margin,
      });
      await recordAlgorithmRun({
        userAlgorithmId: subscription.id,
        symbol: market.symbol,
        side: holding,
        signal: `${signal.signal}_CLOSE`,
        status: 'closed',
      });
      await audit(prisma, {
        action: AuditAction.ALGORITHM_ORDER_PLACED,
        actorType: 'SYSTEM',
        actorUserId: subscription.userId,
        entityType: 'user_algorithm',
        entityId: subscription.id,
        after: { action: 'close', symbol: market.symbol, signal: signal.signal },
      });
      summary.closed += 1;
      continue;
    }

    // Flat and the strategy has an opinion: open, subject to every limit.
    const leverage = Math.max(
      1,
      Math.min(algorithm.maxLeverage, entitlements.maxLeverage, market.maxLeverage),
    );

    const openedToday = await prisma.perpOrder.count({
      where: {
        userId: subscription.userId,
        kind: PerpOrderKind.OPEN,
        submittedAt: { gte: startOfUtcDay() },
      },
    });

    try {
      assertDailyTradesRemaining(entitlements, openedToday);
      assertLeverageAllowed(entitlements, leverage);

      if (!market.markPrice) continue;
      const size = contractsForUsd(
        new Decimal(algorithm.maxNotionalUsd),
        new Decimal(market.markPrice),
        market.sizeDecimals,
      ).toFixed();

      const opened = await openCustodyPerpPosition({
        userId: subscription.userId,
        walletId: wallet.id,
        marketId: row.id,
        intent: {
          symbol: market.symbol,
          side: signal.side,
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
        symbol: market.symbol,
        side: signal.side,
        signal: signal.signal,
        perpOrderId: opened.orderId,
        status: 'opened',
      });
      await audit(prisma, {
        action: AuditAction.ALGORITHM_ORDER_PLACED,
        actorType: 'SYSTEM',
        actorUserId: subscription.userId,
        entityType: 'user_algorithm',
        entityId: subscription.id,
        after: {
          action: 'open',
          symbol: market.symbol,
          side: signal.side,
          leverage,
          size,
          orderId: opened.orderId,
          signal: signal.signal,
        },
      });
      summary.opened += 1;
    } catch (error) {
      // A refusal is a normal outcome — no insurance, insufficient balance, over
      // the daily limit — not a failure. Record why and move on; the next pass
      // will try again once the condition clears.
      summary.refused += 1;
      const code = error instanceof DomainError ? error.code : 'ERROR';
      const message = error instanceof Error ? error.message : String(error);

      await recordAlgorithmRun({
        userAlgorithmId: subscription.id,
        symbol: market.symbol,
        side: signal.side,
        signal: signal.signal,
        status: 'refused',
        reason: code,
      });
      await audit(prisma, {
        action: AuditAction.ALGORITHM_ORDER_REFUSED,
        actorType: 'SYSTEM',
        actorUserId: subscription.userId,
        entityType: 'user_algorithm',
        entityId: subscription.id,
        after: { symbol: market.symbol, signal: signal.signal, code, message },
      });
    }
  }

  return summary;
}
