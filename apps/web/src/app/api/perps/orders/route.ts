import { z } from 'zod';
import { prisma } from '@flt/db';
import { resolveTradingWallet } from '@flt/core/services/wallets';
import { prepareClose, prepareOpen } from '@flt/core/services/perps';
import { RateLimits } from '@flt/core/services/ratelimit';
import { perpVenue } from '@flt/providers';
import { handler } from '@/server/api';
import { ValidationError, Decimal, NotFoundError } from '@flt/core/domain';
import { contractsForUsd } from '@flt/core/protection';
import type { PerpVenue } from '@flt/core/ports';

/**
 * Prepares a perpetual order for the client to sign.
 *
 * The response is the whole contract between FLT and the user for this trade:
 * the exact order that will be sent, the margin it requires, the liquidation
 * price it implies and where that number came from. The same fields are
 * persisted server-side first, so what the user approved can be compared
 * against what the venue reports having filled.
 *
 * FLT does not submit the order. The client signs it with a key this server
 * has never seen and posts it to the venue itself.
 */
const decimalString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal number');

const schema = z.object({
  action: z.enum(['open', 'close']),
  symbol: z.string().trim().min(1).max(24),
  side: z.enum(['LONG', 'SHORT']).optional(),
  /** Omitted on a close means close the whole position. */
  size: decimalString.optional(),
  /**
   * Position size in USD, which is how the ticket asks for it.
   *
   * Preferred over `size` on an open: the conversion to contracts happens on
   * the server at the server's own mark, so the browser's rounding is never
   * what gets traded. `size` remains accepted for closes and for API callers
   * that genuinely think in contracts.
   */
  usdNotional: decimalString.optional(),
  /** The cover level chosen, when protection is being bought with the trade. */
  protectionPercentile: z.coerce.number().gt(0.5).lt(1).optional(),
  orderType: z
    .enum(['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT', 'TAKE_PROFIT_MARKET', 'TAKE_PROFIT_LIMIT'])
    .optional(),
  /** Required for the trigger types. */
  triggerPrice: decimalString.nullish(),
  /** Bracket legs, submitted with the entry as an OCO. */
  takeProfitPrice: decimalString.nullish(),
  stopLossPrice: decimalString.nullish(),
  leverage: z.coerce.number().int().min(1).max(100).optional(),
  marginMode: z.enum(['ISOLATED', 'CROSS']).default('ISOLATED'),
  limitPrice: decimalString.nullish(),
  slippageBps: z.coerce.number().int().min(0).max(1_000).default(50),
  reduceOnly: z.boolean().default(false),
});

export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.QUOTE, scope: 'perp-order' } },
  async ({ body, user, context }) => {
    const venue = perpVenue();
    const wallet = await resolveTradingWallet(prisma, user.id);

    if (body.action === 'close') {
      const { order, action } = await prepareClose(venue, {
        user,
        wallet,
        symbol: body.symbol,
        size: body.size ?? null,
        slippageBps: body.slippageBps ?? 50,
        ip: context.ip,
        userAgent: context.userAgent,
      });

      return { orderId: order.id, action, kind: 'CLOSE' as const };
    }

    if (!body.side || !body.leverage || (!body.size && !body.usdNotional)) {
      throw new ValidationError(
        'Opening a position requires a side, a leverage, and a size in either dollars or contracts',
      );
    }

    // Dollars are converted here rather than in the browser, so the contract
    // count that reaches the venue is the one this server computed from its
    // own mark price. Rounded down, so the position is never worth more than
    // the dollars the user approved.
    const size = body.usdNotional
      ? await sizeFromUsd(venue, body.symbol, body.usdNotional)
      : body.size!;

    const result = await prepareOpen(venue, {
      user,
      wallet,
      intent: {
        symbol: body.symbol,
        side: body.side,
        size,
        leverage: body.leverage,
        marginMode: body.marginMode ?? 'ISOLATED',
        limitPrice: body.limitPrice ?? null,
        slippageBps: body.slippageBps ?? 50,
        reduceOnly: body.reduceOnly ?? false,
        protectionPercentile: body.protectionPercentile,
        orderType: body.orderType,
        triggerPrice: body.triggerPrice ?? null,
        takeProfitPrice: body.takeProfitPrice ?? null,
        stopLossPrice: body.stopLossPrice ?? null,
      },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return {
      orderId: result.order.id,
      kind: 'OPEN' as const,
      action: result.action,
      preview: result.preview,
      liquidation: result.liquidation,
      warnings: result.warnings,
    };
  },
);

async function sizeFromUsd(venue: PerpVenue, symbol: string, usd: string): Promise<string> {
  const market = await venue.getMarket(symbol);
  if (!market) throw new NotFoundError('Market');
  if (!market.markPrice) {
    throw new ValidationError('The venue is not quoting this market', { symbol });
  }
  return contractsForUsd(
    new Decimal(usd),
    new Decimal(market.markPrice),
    market.sizeDecimals,
  ).toFixed();
}
