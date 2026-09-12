import { z } from 'zod';
import { prisma } from '@flt/db';
import { resolveTradingWallet } from '@flt/core/services/wallets';
import { assertCanOpenPerp, resolveOfferedMarket } from '@flt/core/services/perps';
import { RateLimits } from '@flt/core/services/ratelimit';
import { perpVenues, openCustodyPerpPosition } from '@flt/providers';
import { contractsForUsd } from '@flt/core/protection';
import { Decimal, NotFoundError, ValidationError } from '@flt/core/domain';
import { handler } from '@/server/api';

/**
 * Places a perpetual order server-side, from the omnibus's venue account,
 * signed by the FLT-held agent key — the participant signs nothing and connects
 * no wallet.
 *
 * This replaces the browser-signed path (see the note in ../orders/route.ts):
 * under ADR 0005 FLT holds the venue key, and under ADR 0006 the participant's
 * margin is reserved on the ledger before the order is broadcast. Placing the
 * order with no participant attributable is refused by construction — the
 * margin lock is what makes this a custody trade rather than a shared account
 * being spent blindly.
 */

const decimalString = z.string().trim().regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal number');

const schema = z.object({
  symbol: z.string().trim().min(1).max(24),
  side: z.enum(['LONG', 'SHORT']),
  /** Size in USD (preferred) or contracts. */
  usdNotional: decimalString.optional(),
  size: decimalString.optional(),
  leverage: z.coerce.number().int().min(1).max(100),
  marginMode: z.enum(['ISOLATED', 'CROSS']).default('ISOLATED'),
  limitPrice: decimalString.nullish(),
  orderType: z
    .enum(['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT', 'TAKE_PROFIT_MARKET', 'TAKE_PROFIT_LIMIT'])
    .default('MARKET'),
  triggerPrice: decimalString.nullish(),
  takeProfitPrice: decimalString.nullish(),
  stopLossPrice: decimalString.nullish(),
  slippageBps: z.coerce.number().int().min(0).max(1_000).default(50),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.QUOTE, scope: 'perp-execute' } },
  async ({ body, user }) => {
    // ADR 0006 P2 — isolated only. Cross margin on the pooled account would let
    // one participant's move liquidate another's position.
    if (body.marginMode !== 'ISOLATED') {
      throw new ValidationError('Only isolated margin is available');
    }

    // The participant's plan must permit perps and this leverage, and the daily
    // opening allowance must not be spent. The live custody path previously
    // skipped this; it is the same gate the prepare path applies, so the two
    // entry points cannot disagree.
    await assertCanOpenPerp({ userId: user.id, leverage: body.leverage });

    const offered = await resolveOfferedMarket(perpVenues(), body.symbol);
    if (!offered) throw new NotFoundError('Market');
    const venue = offered.venue;

    const market = await venue.getMarket(body.symbol);
    if (!market?.markPrice) {
      throw new ValidationError('The venue is not quoting this market', { symbol: body.symbol });
    }

    const size = body.usdNotional
      ? contractsForUsd(
          new Decimal(body.usdNotional),
          new Decimal(market.markPrice),
          market.sizeDecimals,
        ).toFixed()
      : body.size;
    if (!size) throw new ValidationError('Provide a size in dollars or contracts');

    const wallet = await resolveTradingWallet(prisma, user.id);
    const marketRow = await prisma.perpMarket.findFirst({
      where: { venueSlug: venue.meta.slug, symbol: offered.market.symbol },
    });
    if (!marketRow) throw new NotFoundError('Market');

    const result = await openCustodyPerpPosition({
      userId: user.id,
      walletId: wallet.id,
      marketId: marketRow.id,
      intent: {
        symbol: offered.market.symbol,
        side: body.side,
        size,
        leverage: body.leverage,
        marginMode: 'ISOLATED',
        limitPrice: body.limitPrice ?? null,
        slippageBps: body.slippageBps ?? 50,
        reduceOnly: false,
        orderType: body.orderType ?? 'MARKET',
        triggerPrice: body.triggerPrice ?? null,
        takeProfitPrice: body.takeProfitPrice ?? null,
        stopLossPrice: body.stopLossPrice ?? null,
      },
    });

    return {
      orderId: result.orderId,
      venueOrderId: result.venueOrderId,
      margin: result.margin,
      preview: result.preview,
    };
  },
);
