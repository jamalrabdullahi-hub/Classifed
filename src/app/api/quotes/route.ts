import { z } from 'zod';
import { assetSymbol, decimalString, handler } from '@/server/api';
import { ValidationError } from '@/domain/errors';
import { prisma } from '@/server/db';
import { createQuote, toBreakdown } from '@/services/quote';
import { RateLimits } from '@/services/ratelimit';

const schema = z
  .object({
    assetSymbol,
    side: z.enum(['BUY', 'SELL']),
    fiatAmount: decimalString.optional(),
    cryptoAmount: decimalString.optional(),
  })
  .refine(
    (v) => Boolean(v.fiatAmount) !== Boolean(v.cryptoAmount),
    'Supply exactly one of fiatAmount or cryptoAmount',
  );

/**
 * Pricing is entirely server-side. The client sends a side and one amount;
 * the rate, fee and expiry all come from us.
 */
export const POST = handler(
  { schema, rateLimit: { rule: RateLimits.QUOTE, scope: 'quote' } },
  async ({ body, userId }) => {
    if (body.side === 'BUY' && !body.fiatAmount) {
      throw new ValidationError('A buy quote requires a USD amount');
    }
    if (body.side === 'SELL' && !body.cryptoAmount) {
      throw new ValidationError('A sell quote requires a crypto amount');
    }

    const { quote } = await createQuote(prisma, {
      userId,
      assetSymbol: body.assetSymbol,
      side: body.side,
      fiatAmount: body.fiatAmount,
      cryptoAmount: body.cryptoAmount,
    });
    return toBreakdown(quote, body.assetSymbol);
  },
);
