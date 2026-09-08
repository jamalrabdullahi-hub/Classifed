import { Decimal } from '@flt/core/domain';
import { resolveOfferedMarket } from '@flt/core/services/perps';
import { NotFoundError } from '@flt/core/domain';
import { perpVenues } from '@flt/providers';
import { routeHandler } from '@/server/api';

/**
 * The resting order book for one market.
 *
 * Cumulative totals and the depth ratio are computed here rather than in the
 * browser, so the ladder renders identically wherever it is drawn and the
 * client is not doing arithmetic on every poll. The ratio drives the depth
 * shading behind each row, and is relative to the largest cumulative total on
 * either side — shading each side against its own maximum would make a thin
 * side look as deep as a heavy one.
 */
export const GET = routeHandler<unknown, { symbol: string }, unknown>(
  // Public market data, nothing account-specific — the terminal now renders
  // for a signed-out visitor too, and a locked order book would defeat the
  // point of letting them look before they sign in.
  { auth: false },
  async ({ params, request }) => {
    // Resolved across venues: an equity or FX symbol lives on Ostium and a
    // crypto one on Hyperliquid, and asking the wrong venue returns nothing.
    const offered = await resolveOfferedMarket(perpVenues(), params.symbol);
    if (!offered) throw new NotFoundError('Market');
    const { venue } = offered;

    const depth = Number(new URL(request.url).searchParams.get('depth') ?? 12);
    const book = await venue.getOrderBook(
      offered.market.symbol,
      Number.isFinite(depth) ? Math.min(Math.max(depth, 1), 25) : 12,
    );

    const cumulate = (levels: typeof book.bids) => {
      let running = new Decimal(0);
      return levels.map((level) => {
        running = running.plus(level.size);
        return { ...level, total: running.toFixed() };
      });
    };

    const bids = cumulate(book.bids);
    const asks = cumulate(book.asks);

    const deepest = Decimal.max(
      bids.length ? (bids[bids.length - 1]?.total ?? '0') : '0',
      asks.length ? (asks[asks.length - 1]?.total ?? '0') : '0',
      '1',
    );

    const withRatio = (levels: typeof bids) =>
      levels.map((level) => ({
        ...level,
        ratio: new Decimal(level.total).dividedBy(deepest).toDecimalPlaces(4).toNumber(),
      }));

    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;

    return {
      symbol: book.symbol,
      bids: withRatio(bids),
      asks: withRatio(asks),
      bestBid,
      bestAsk,
      spread:
        bestBid && bestAsk ? new Decimal(bestAsk).minus(bestBid).toFixed() : null,
      capturedAt: book.capturedAt.toISOString(),
    };
  },
);
