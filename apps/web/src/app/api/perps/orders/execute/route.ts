import { z } from 'zod';
import { prisma } from '@flt/db';
import { resolveTradingWallet } from '@flt/core/services/wallets';
import {
  assertCanOpenPerp,
  assertMinimumOrderValue,
  resolveOfferedMarket,
} from '@flt/core/services/perps';
import { RateLimits } from '@flt/core/services/ratelimit';
import { perpVenues, openCustodyPerpPosition } from '@flt/providers';
import { contractsForUsd } from '@flt/core/protection';
import { Decimal, NotFoundError, ValidationError } from '@flt/core/domain';
import { createPolicy } from '@flt/core/services/protection-policies';
import { AuditAction, audit } from '@flt/core/services/audit';
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

  /**
   * Cover bought with this order.
   *
   * Present when the ticket's coverage panel is on. Until now that panel priced
   * a policy and bought nothing: the premium was displayed, the order was sent
   * without it, and with PROTECTION_MODE=required the open was then refused for
   * having no policy — a policy that could not be written first, because a
   * policy needs a position to anchor to. Sending the terms with the order is
   * what breaks that circle.
   */
  cover: z
    .object({
      kind: z.enum(['BASE_DAY', 'BASE_SMOOTH', 'OMNI']),
      percentile: z.coerce.number().gt(0.5).lt(1).optional(),
      horizonDays: z.coerce.number().positive().max(365).optional(),
      smoothStartAt: z.string().trim().optional(),
      interval: z.string().trim().optional(),
      window: z.coerce.number().int().min(20).max(500).optional(),
    })
    .optional(),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.QUOTE, scope: 'perp-execute' } },
  async ({ body, user }) => {
    // ADR 0006 P2 — isolated only. Cross margin on the pooled account would let
    // one participant's move liquidate another's position.
    if (body.marginMode !== 'ISOLATED') {
      throw new ValidationError('Only isolated margin is available');
    }

    /**
     * The three independent lookups run together.
     *
     * The plan check, the market resolution and the trading wallet do not
     * depend on one another, and each was a separate round trip awaited in
     * turn — three sequential waits before the order had even been sized, on
     * the path a participant is watching a spinner on. The venue call that
     * follows needs the resolved market, so it stays after.
     */
    const [, offered, wallet] = await Promise.all([
      // The participant's plan must permit perps and this leverage, and the
      // daily opening allowance must not be spent. Same gate the prepare path
      // applies, so the two entry points cannot disagree.
      assertCanOpenPerp({ userId: user.id, leverage: body.leverage }),
      resolveOfferedMarket(perpVenues(), body.symbol),
      resolveTradingWallet(prisma, user.id),
    ]);

    if (!offered) throw new NotFoundError('Market');
    const venue = offered.venue;

    const [market, marketRow] = await Promise.all([
      venue.getMarket(body.symbol),
      prisma.perpMarket.findFirst({
        where: { venueSlug: venue.meta.slug, symbol: offered.market.symbol },
      }),
    ]);

    if (!market?.markPrice) {
      throw new ValidationError('The venue is not quoting this market', { symbol: body.symbol });
    }
    if (!marketRow) throw new NotFoundError('Market');

    const contracts = body.usdNotional
      ? contractsForUsd(
          new Decimal(body.usdNotional),
          new Decimal(market.markPrice),
          market.sizeDecimals,
        )
      : body.size
        ? new Decimal(body.size)
        : null;
    if (!contracts) throw new ValidationError('Provide a size in dollars or contracts');

    /**
     * The venue's minimum order *value*, refused here with the figure that
     * clears it.
     *
     * This rule existed only on the prepare route — which the terminal stopped
     * calling when execution moved server-side — so an order under $10 reached
     * Hyperliquid and came back as "Order must have minimum value of $10" with
     * nothing telling the participant what to change.
     */
    assertMinimumOrderValue({
      venueSlug: venue.meta.slug,
      venueName: venue.meta.name,
      contracts,
      markPrice: market.markPrice,
    });

    const size = contracts.toFixed();

    const result = await openCustodyPerpPosition({
      userId: user.id,
      walletId: wallet.id,
      marketId: marketRow.id,
      buyingCover: Boolean(body.cover),
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

    /**
     * Write the cover, now that there is a position to anchor it to.
     *
     * After the open rather than before, because `createPolicy` measures a real
     * entry and a real liquidation price and refuses a position that does not
     * exist. The order is already filled at this point, so a failure here is
     * reported rather than thrown: throwing would tell the participant their
     * order failed when it did not, and they would place it again.
     */
    let cover: { policyId: string } | null = null;
    let coverError: string | null = null;

    if (body.cover) {
      try {
        const { policy } = await createPolicy(
          venue,
          { user, wallet },
          {
            kind: body.cover.kind as never,
            symbol: offered.market.symbol,
            percentile: body.cover.percentile,
            horizonDays: body.cover.horizonDays,
            smoothStartAt: body.cover.smoothStartAt,
            interval: body.cover.interval as never,
            window: body.cover.window,
          },
        );
        cover = { policyId: policy.id };
      } catch (error) {
        coverError = error instanceof Error ? error.message : String(error);
        /*
         * A leveraged position now exists with no cover behind it. That is the
         * state the requirement exists to prevent, so it is audited rather than
         * only logged — an operator has to be able to find it.
         */
        await audit(prisma, {
          action: AuditAction.PERP_ORDER_REJECTED,
          entityType: 'PerpOrder',
          entityId: result.orderId,
          actorType: 'SYSTEM',
          actorUserId: user.id,
          after: { coverRequested: true, coverWritten: false, reason: coverError },
        }).catch(() => undefined);
      }
    }

    return {
      orderId: result.orderId,
      venueOrderId: result.venueOrderId,
      margin: result.margin,
      preview: result.preview,
      cover,
      coverError,
    };
  },
);
