import { PerpOrderKind, PerpOrderStatus, prisma } from '@flt/db';
import { env } from '@flt/config';
import { Decimal, liquidationProximity } from '@flt/core/domain';
import { assertPerpsEnabled } from '@flt/core/services/perps';
import { clientBalance } from '@flt/core/services/ledger';
import { perpVenue } from '@flt/providers';
import { handler } from '@/server/api';

const MARGIN_ASSET = 'USDC';

/**
 * Open positions, attributed to the caller, with what they own and owe.
 *
 * ## Why this reads the omnibus, not the user's wallet
 *
 * Under custody every participant's perp position sits on the omnibus's single
 * venue account — the participant's own wallet holds nothing, so reading it (the
 * old behaviour) always came back empty. The **live** venue data — the mark and
 * the pool's liquidation — comes from the omnibus, and the participant's *share*
 * is reconstructed from their own `PerpOrder` rows: the latest order for a market
 * being an OPEN means they are in it, a CLOSE means they are flat. That is the
 * same attribution the runner uses.
 *
 * ## What they own and owe
 *
 * The account tiles are the participant's **custody ledger balance**, not the
 * venue's pooled account: `accountValue` is everything they hold, `marginInUse`
 * is what is reserved against open positions, and `available` is what is
 * spendable. Unrealized PnL is estimated from the attributed entry and size.
 */
export const GET = handler({}, async ({ user }) => {
  assertPerpsEnabled();

  const venue = perpVenue();
  const omnibus = env().OMNIBUS_EVM_ADDRESS;

  const [orders, omnibusPositions, markets, balance] = await Promise.all([
    prisma.perpOrder.findMany({
      where: { userId: user.id, venueSlug: venue.meta.slug },
      include: { market: { select: { symbol: true } } },
      orderBy: { id: 'desc' },
    }),
    omnibus ? venue.getPositions({ address: omnibus }) : Promise.resolve([]),
    venue.listMarkets(),
    clientBalance(user.id, MARGIN_ASSET),
  ]);

  const markBySymbol = new Map(markets.map((market) => [market.symbol, market.markPrice]));
  const poolBySymbol = new Map(omnibusPositions.map((position) => [position.symbol, position]));

  // The latest order per market decides the live attribution (uuidv7 is ordered).
  const latest = new Map<string, (typeof orders)[number]>();
  for (const order of orders) {
    if (!latest.has(order.marketId)) latest.set(order.marketId, order);
  }

  const positions: Array<Record<string, unknown>> = [];
  let totalUnrealized = new Decimal(0);

  for (const order of latest.values()) {
    if (order.kind !== PerpOrderKind.OPEN) continue; // latest was a close → flat
    if (order.status === PerpOrderStatus.REJECTED || order.status === PerpOrderStatus.ABANDONED) {
      continue;
    }

    const symbol = order.market.symbol;
    const mark = markBySymbol.get(symbol) ?? null;
    const entry = order.referencePrice ?? order.limitPrice ?? null;
    const size = order.size;
    const dir = order.side === 'LONG' ? 1 : -1;

    const unrealized =
      mark && entry && Number.isFinite(Number(mark)) && Number.isFinite(Number(entry))
        ? new Decimal(mark).minus(entry).times(dir).times(size)
        : null;
    if (unrealized) totalUnrealized = totalUnrealized.plus(unrealized);

    // The venue reports the pool's liquidation; it is the best available figure
    // for this market (per-participant liquidation on a pooled account is not
    // something the venue exposes).
    const liquidation = poolBySymbol.get(symbol)?.liquidationPrice ?? null;

    positions.push({
      symbol,
      side: order.side,
      size,
      entryPrice: entry ?? '0',
      markPrice: mark,
      margin: order.marginRequired ?? '0',
      marginMode: order.marginMode,
      leverage: order.leverage,
      liquidationPrice: liquidation,
      unrealizedPnl: unrealized ? unrealized.toFixed(2) : null,
      fundingPaid: null,
      proximity:
        mark && entry && liquidation ? liquidationProximity(mark, entry, liquidation) : null,
      notionalValue: mark ? new Decimal(size).times(mark).toFixed() : null,
    });
  }

  return {
    summary: {
      accountValue: balance.total.toFixed(2),
      withdrawable: balance.available.toFixed(2),
      totalMarginUsed: balance.locked.toFixed(2),
      totalUnrealizedPnl: totalUnrealized.toFixed(2),
      hasCollateral: balance.total.greaterThan(0),
    },
    requiresBridgedCollateral: venue.requiresBridgedCollateral,
    positions,
  };
});
