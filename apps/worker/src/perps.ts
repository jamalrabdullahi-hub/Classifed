import { HyperliquidPerpVenue } from '@flt/providers';
import type { VenueFill } from '@flt/core/ports/market-making';
import { PerpOrderStatus, prisma } from '@flt/db';
import { env } from '@flt/config';
import { Decimal, liquidationProximity, newId } from '@flt/core/domain';
import { AuditAction, audit } from '@flt/core/services/audit';
import { settlePerpRealized } from '@flt/core/services';
import { perpVenue } from '@flt/providers';

/**
 * Perpetual position sync.
 *
 * Two jobs, and the second is the reason this exists at all.
 *
 * **Snapshotting** keeps a copy of each open position so a position list can
 * render without waiting on the venue, and so anything that needs to reason
 * about positions between page loads has something to read.
 *
 * **Reconciliation** is the substantive one. FLT prepares orders but never
 * submits them, so it cannot witness a fill. Without a pass that compares what
 * was prepared against what the venue actually did, an order that was altered
 * between preparation and submission would leave no trace — which is precisely
 * the hole the spot path closes by hashing calldata and checking it on-chain.
 * Here the same guarantee is reconstructed after the fact: an order recorded as
 * submitted is matched against the venue's positions, and a mismatch is written
 * as a security audit event rather than quietly reconciled away.
 *
 * A position that vanishes while an order is outstanding is not treated as a
 * fill. It is at least as likely to be a liquidation, and calling one the other
 * would tell a user their trade completed when in fact their margin is gone.
 */

export interface PerpSyncResult {
  wallets: number;
  positions: number;
  reconciled: number;
  discrepancies: number;
  liquidationsSuspected: number;
}

/** Positions past this share of the distance to liquidation are worth recording loudly. */
const DANGER_PROXIMITY = 0.9;

export async function syncPerpetuals(): Promise<PerpSyncResult> {
  const result: PerpSyncResult = {
    wallets: 0,
    positions: 0,
    reconciled: 0,
    discrepancies: 0,
    liquidationsSuspected: 0,
  };

  if (!env().PERPS_ENABLED) return result;

  const venue = perpVenue();

  // Only wallets that have actually done something with perpetuals. Polling
  // every verified wallet on the platform would spend the venue's rate limit
  // on accounts that have never opened a position.
  const wallets = await prisma.wallet.findMany({
    where: {
      verifiedAt: { not: null },
      OR: [{ perpOrders: { some: {} } }, { perpPositionSnapshots: { some: {} } }],
    },
    select: { id: true, address: true, userId: true },
  });

  result.wallets = wallets.length;

  for (const wallet of wallets) {
    try {
      const positions = await venue.getPositions({ address: wallet.address });
      result.positions += positions.length;

      const markets = await prisma.perpMarket.findMany({
        where: { venueSlug: venue.meta.slug },
        select: { id: true, symbol: true },
      });
      const marketBySymbol = new Map(markets.map((market) => [market.symbol, market.id]));

      // The venue reports positions without a mark price, so it has to come
      // from the market list. Without it `markPrice` was never written, and the
      // near-liquidation check below — which reads it off the last snapshot —
      // could never fire, making PERP_POSITION_LIQUIDATED unreachable. The
      // interface hid this by joining the mark price live at read time.
      const live = positions.length > 0 ? await venue.listMarkets() : [];
      const markBySymbol = new Map(live.map((market) => [market.symbol, market.markPrice]));

      const seen = new Set<string>();

      for (const position of positions) {
        const marketId = marketBySymbol.get(position.symbol);
        // A position on a market FLT does not list is real and the user's, but
        // it is not ours to record. It stays visible through the live read.
        if (!marketId) continue;

        seen.add(marketId);

        await prisma.perpPositionSnapshot.upsert({
          where: { walletId_marketId: { walletId: wallet.id, marketId } },
          create: {
            id: newId(),
            userId: wallet.userId,
            walletId: wallet.id,
            marketId,
            venueSlug: venue.meta.slug,
            side: position.side,
            size: position.size,
            entryPrice: position.entryPrice,
            margin: position.margin,
            marginMode: position.marginMode,
            leverage: position.leverage,
            liquidationPrice: position.liquidationPrice,
            markPrice: markBySymbol.get(position.symbol) ?? null,
            unrealizedPnl: position.unrealizedPnl,
            fundingPaid: position.fundingPaid,
            capturedAt: new Date(),
          },
          update: {
            side: position.side,
            size: position.size,
            entryPrice: position.entryPrice,
            margin: position.margin,
            marginMode: position.marginMode,
            leverage: position.leverage,
            liquidationPrice: position.liquidationPrice,
            // Kept from the previous snapshot when the venue is momentarily not
            // quoting: a null here would erase the last known mark and disarm
            // the liquidation check exactly when it matters most.
            ...(markBySymbol.get(position.symbol)
              ? { markPrice: markBySymbol.get(position.symbol) }
              : {}),
            unrealizedPnl: position.unrealizedPnl,
            fundingPaid: position.fundingPaid,
            capturedAt: new Date(),
          },
        });
      }

      // Positions the venue no longer reports have been closed or liquidated.
      const stale = await prisma.perpPositionSnapshot.findMany({
        where: { walletId: wallet.id, marketId: { notIn: [...seen] } },
        include: { market: { select: { symbol: true } } },
      });

      // The last PnL the venue reported for a position that has now vanished is
      // the best available realized figure — captured before the row is deleted
      // so the settlement below has something to book.
      const stalePnlByMarket = new Map<string, string | null>();
      for (const snapshot of stale) stalePnlByMarket.set(snapshot.marketId, snapshot.unrealizedPnl);

      for (const snapshot of stale) {
        const wasNearLiquidation =
          snapshot.liquidationPrice &&
          snapshot.markPrice &&
          Number(
            liquidationProximity(snapshot.markPrice, snapshot.entryPrice, snapshot.liquidationPrice),
          ) >= DANGER_PROXIMITY;

        if (wasNearLiquidation) {
          result.liquidationsSuspected += 1;
          // Recorded as suspected, not as fact. The venue does not tell us why
          // a position closed, and asserting a liquidation we did not witness
          // would put a false statement in a user's history.
          await audit(prisma, {
            action: AuditAction.PERP_POSITION_LIQUIDATED,
            actorType: 'SYSTEM',
            actorUserId: snapshot.userId,
            entityType: 'perp_position',
            entityId: snapshot.id,
            before: {
              symbol: snapshot.market.symbol,
              side: snapshot.side,
              size: snapshot.size,
              entryPrice: snapshot.entryPrice,
              liquidationPrice: snapshot.liquidationPrice,
              lastMarkPrice: snapshot.markPrice,
              note: 'Position disappeared while close to its liquidation price. Cause not observed.',
            },
          });
        }

        await prisma.perpPositionSnapshot.delete({ where: { id: snapshot.id } });
      }

      // Under custody the positions live on the omnibus, not on this wallet, so
      // the per-wallet order reconcile is skipped — it would mark a close filled
      // unconditionally, since the wallet never shows a position. The custody
      // pass after the loop reconciles against the omnibus instead.
      if (env().CUSTODY_PROVIDER === 'disabled') {
        result.reconciled += await reconcileOrders(wallet, positions, venue.meta.slug, result, stalePnlByMarket);
      }
    } catch (error) {
      // One wallet failing must not stop the pass. The venue rate-limits, and
      // a single bad account should not stall every other user's sync.
      console.error('[perps] wallet sync failed', {
        walletId: wallet.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Custody: one pooled venue account, so reconcile every outstanding order
  // against the omnibus's positions once, not per wallet.
  const omnibusAddress = env().OMNIBUS_EVM_ADDRESS;
  if (env().CUSTODY_PROVIDER !== 'disabled' && omnibusAddress) {
    try {
      const omnibusPositions = await venue.getPositions({ address: omnibusAddress });
      /**
       * The omnibus's fills, read once per pass.
       *
       * Realised P&L is a statement about prices that actually traded, so it
       * comes from fills — matched to each order by the venue order id the
       * submit returned — rather than from the pooled position, whose entry is
       * an average over every participant in it. Only Hyperliquid reports fills
       * this way; other venues keep the previous behaviour.
       */
      const fills =
        venue.meta.slug === 'hyperliquid'
          ? await new HyperliquidPerpVenue().getFills({ address: omnibusAddress })
          : null;
      result.reconciled += await reconcileCustodyOrders(omnibusPositions, venue.meta.slug, fills);
    } catch (error) {
      console.error('[perps] custody reconcile failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * Reconciles the pooled account's outstanding orders against its positions.
 *
 * A CLOSE order whose market no longer holds a position is the close fill, and
 * is settled here: the reserved margin is released. The realized PnL is booked
 * as zero — the venue reports the *pooled* account's PnL, which cannot be
 * attributed to one participant under ADR 0006 (P1/P10), so an exact figure is a
 * deliberate follow-up, not a guess. An OPEN order marks FILLED once its
 * position appears; its margin was already reserved at open.
 */
/** Size-weighted average price, total size and total fee of one order's fills. */
function fillsForOrder(
  fills: VenueFill[],
  venueOrderId: string | null,
): { price: Decimal; size: Decimal; fee: Decimal } | null {
  if (!venueOrderId) return null;
  const oid = Number(venueOrderId);
  if (!Number.isFinite(oid)) return null;

  const own = fills.filter((fill) => fill.venueOid === oid);
  if (own.length === 0) return null;

  let size = new Decimal(0);
  let notional = new Decimal(0);
  let fee = new Decimal(0);
  for (const fill of own) {
    const fillSize = new Decimal(fill.size).abs();
    size = size.plus(fillSize);
    notional = notional.plus(fillSize.times(fill.price));
    fee = fee.plus(new Decimal(fill.feeUsd));
  }
  if (size.isZero()) return null;
  return { price: notional.dividedBy(size), size, fee };
}

/** How long a close may wait for its fills to appear before settling without them. */
const CLOSE_FILL_GRACE_MS = 60 * 60_000;

async function reconcileCustodyOrders(
  positions: Array<{ symbol: string; side: string; size: string; entryPrice: string }>,
  venueSlug: string,
  fills: VenueFill[] | null,
): Promise<number> {
  const orders = await prisma.perpOrder.findMany({
    where: { venueSlug, status: { in: [PerpOrderStatus.SUBMITTED, PerpOrderStatus.FILLED] } },
    include: { market: { select: { symbol: true } } },
  });

  // The size the pool should hold once every attributed order is reflected:
  // opens add, closes subtract. A close has landed when the venue's position has
  // shrunk to this — which generalises the old "position vanished" rule to the
  // partial, per-participant exit a pooled account actually gets.
  const expectedNet = new Map<string, Decimal>();
  for (const order of orders) {
    const symbol = order.market.symbol;
    const size = new Decimal(order.size || '0');
    const delta = order.kind === 'CLOSE' ? size.negated() : size;
    expectedNet.set(symbol, (expectedNet.get(symbol) ?? new Decimal(0)).plus(delta));
  }
  const poolBySymbol = new Map(positions.map((p) => [p.symbol, new Decimal(p.size).abs()]));
  const TOLERANCE = new Decimal('0.00000001');

  let reconciled = 0;

  for (const order of orders) {
    if (order.status !== PerpOrderStatus.SUBMITTED) continue;
    const symbol = order.market.symbol;
    const pool = poolBySymbol.get(symbol) ?? new Decimal(0);
    const net = (expectedNet.get(symbol) ?? new Decimal(0)).abs();

    if (order.kind === 'CLOSE') {
      // The close has landed once the pool no longer exceeds the net of all
      // attributed orders. Settle BEFORE marking filled: a settle that fails
      // leaves the order outstanding so the next pass retries, rather than a
      // close recorded as done with its margin still reserved.
      if (pool.greaterThan(net.plus(TOLERANCE))) continue;

      /**
       * The realised P&L, from prices that actually traded.
       *
       * This used to settle every custody close with a P&L of zero: the margin
       * came back and the gain or loss on the position never reached the
       * participant's balance. The exit is the close order's own fills; the
       * entry is the participant's own opening order, captured from its fills
       * when it filled — not the pooled position's entry, which averages every
       * participant holding the market.
       */
      let pnl = new Decimal(0);
      let fee = new Decimal(0);
      let exitPrice: Decimal | null = null;

      if (fills) {
        const exit = fillsForOrder(fills, order.venueOrderId);
        const entryOrder = await prisma.perpOrder.findFirst({
          where: {
            userId: order.userId,
            marketId: order.marketId,
            kind: 'OPEN',
            id: { lt: order.id },
          },
          orderBy: { id: 'desc' },
        });
        const entryPrice = entryOrder?.averageFillPrice ? new Decimal(entryOrder.averageFillPrice) : null;

        if (exit && entryPrice && entryOrder) {
          const size = new Decimal(order.size || '0').abs();
          const move = exit.price.minus(entryPrice).times(size);
          pnl = entryOrder.side === 'SHORT' ? move.negated() : move;
          fee = exit.fee;
          exitPrice = exit.price;
        } else {
          const waited = Date.now() - (order.submittedAt?.getTime() ?? Date.now());
          if (waited < CLOSE_FILL_GRACE_MS) {
            // The fills are not visible yet. Wait for them rather than book a
            // P&L that was not measured.
            continue;
          }
          // Past the grace period the fills have left the venue's window, or the
          // entry predates entry capture. Release the margin so the participant
          // is not frozen, and say plainly that the P&L was not measured.
          console.error('[perps] close settled without a measured P&L', {
            orderId: order.id,
            haveExitFills: Boolean(exit),
            haveEntryPrice: Boolean(entryPrice),
          });
        }
      }

      const margin = new Decimal(order.marginRequired ?? '0');
      if (margin.greaterThan(0)) {
        await settlePerpRealized({
          userId: order.userId,
          reference: `perp-close:${order.id}`,
          margin,
          pnl,
          fee,
        });
      }

      await prisma.perpOrder.update({
        where: { id: order.id },
        data: {
          status: PerpOrderStatus.FILLED,
          settledAt: new Date(),
          ...(exitPrice ? { averageFillPrice: exitPrice.toFixed() } : {}),
        },
      });
      reconciled += 1;
      continue;
    }

    // An OPEN order marks filled once the pool holds anything for the market;
    // its margin was already reserved at open. Its own average fill price is
    // recorded now, because it is the entry this participant's P&L is measured
    // from at close, and the venue's fill history does not reach back forever.
    if (pool.greaterThan(0)) {
      const own = fills ? fillsForOrder(fills, order.venueOrderId) : null;
      if (fills && !own) {
        const waited = Date.now() - (order.submittedAt?.getTime() ?? Date.now());
        if (waited < CLOSE_FILL_GRACE_MS) continue;
      }
      await prisma.perpOrder.update({
        where: { id: order.id },
        data: {
          status: PerpOrderStatus.FILLED,
          settledAt: new Date(),
          ...(own ? { averageFillPrice: own.price.toFixed(), filledSize: own.size.toFixed() } : {}),
        },
      });
      reconciled += 1;
    }
  }

  return reconciled;
}

/**
 * Matches submitted orders against what the venue holds.
 *
 * An order is only marked filled when a position exists that is consistent with
 * it. "Consistent" is deliberately loose on size — a partial fill is normal and
 * is recorded as such — but strict on direction and market, because those are
 * the fields whose divergence would mean the user got a trade they did not
 * approve.
 */
async function reconcileOrders(
  wallet: { id: string; userId: string },
  positions: Array<{ symbol: string; side: string; size: string; entryPrice: string }>,
  venueSlug: string,
  result: PerpSyncResult,
  stalePnlByMarket: Map<string, string | null>,
): Promise<number> {
  const outstanding = await prisma.perpOrder.findMany({
    where: { walletId: wallet.id, venueSlug, status: PerpOrderStatus.SUBMITTED },
    include: { market: { select: { symbol: true } } },
  });

  let reconciled = 0;

  for (const order of outstanding) {
    const position = positions.find((p) => p.symbol === order.market.symbol);

    if (!position) {
      // A close that leaves no position is exactly what a close should do.
      if (order.kind === 'CLOSE') {
        await prisma.perpOrder.update({
          where: { id: order.id },
          data: { status: PerpOrderStatus.FILLED, settledAt: new Date() },
        });

        // The close filled: release the reserved margin and book the realized
        // PnL. Idempotent on the order id, so a re-run cannot double-settle.
        const margin = new Decimal(order.marginRequired ?? '0');
        if (margin.greaterThan(0)) {
          await settlePerpRealized({
            userId: order.userId,
            reference: `perp-close:${order.id}`,
            margin,
            pnl: new Decimal(stalePnlByMarket.get(order.marketId) ?? '0'),
            fee: new Decimal(0),
          });
        }
        reconciled += 1;
      }
      continue;
    }

    if (order.kind === 'CLOSE') continue;

    // Direction is the field that must never differ. A long order that produced
    // a short position is not a partial fill, it is a different trade.
    if (position.side !== order.side) {
      result.discrepancies += 1;

      await prisma.perpOrder.update({
        where: { id: order.id },
        data: {
          status: PerpOrderStatus.FILLED,
          settledAt: new Date(),
          discrepancy: `Order prepared as ${order.side} but the resulting position is ${position.side}`,
          averageFillPrice: position.entryPrice,
        },
      });

      await audit(prisma, {
        action: AuditAction.PERP_ORDER_DIVERGED,
        actorType: 'SYSTEM',
        actorUserId: order.userId,
        entityType: 'perp_order',
        entityId: order.id,
        before: { side: order.side, size: order.size, symbol: order.market.symbol },
        after: { side: position.side, size: position.size, entryPrice: position.entryPrice },
      });

      reconciled += 1;
      continue;
    }

    const filled = new Decimal(position.size);
    const requested = new Decimal(order.size);
    const partial = filled.lessThan(requested);

    await prisma.perpOrder.update({
      where: { id: order.id },
      data: {
        status: partial ? PerpOrderStatus.PARTIALLY_FILLED : PerpOrderStatus.FILLED,
        filledSize: position.size,
        averageFillPrice: position.entryPrice,
        settledAt: new Date(),
      },
    });

    await audit(prisma, {
      action: AuditAction.PERP_ORDER_FILLED,
      actorType: 'SYSTEM',
      actorUserId: order.userId,
      entityType: 'perp_order',
      entityId: order.id,
      after: {
        symbol: order.market.symbol,
        filledSize: position.size,
        entryPrice: position.entryPrice,
        partial,
      },
    });

    reconciled += 1;
  }

  return reconciled;
}
