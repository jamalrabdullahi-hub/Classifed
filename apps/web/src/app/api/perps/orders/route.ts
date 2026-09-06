import { z } from 'zod';
import { prisma } from '@flt/db';
import { resolveTradingWallet } from '@flt/core/services/wallets';
import { prepareClose, prepareOpen } from '@flt/core/services/perps';
import { RateLimits } from '@flt/core/services/ratelimit';
import { perpVenue } from '@flt/providers';
import { handler } from '@/server/api';

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

    if (!body.side || !body.size || !body.leverage) {
      throw new Error('Opening a position requires a side, a size and a leverage');
    }

    const result = await prepareOpen(venue, {
      user,
      wallet,
      intent: {
        symbol: body.symbol,
        side: body.side,
        size: body.size,
        leverage: body.leverage,
        marginMode: body.marginMode ?? 'ISOLATED',
        limitPrice: body.limitPrice ?? null,
        slippageBps: body.slippageBps ?? 50,
        reduceOnly: body.reduceOnly ?? false,
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
