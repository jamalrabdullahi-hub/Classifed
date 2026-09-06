import { z } from 'zod';
import { ProtectionPolicyKind, prisma } from '@flt/db';
import { Decimal } from '@flt/core/domain';
import { resolveTradingWallet } from '@flt/core/services/wallets';
import { assertPerpsEnabled } from '@flt/core/services/perps';
import { preparePurchase, confirmPurchase } from '@flt/core/services/protection-purchase';
import { RateLimits } from '@flt/core/services/ratelimit';
import { perpVenue } from '@flt/providers';
import { handler } from '@/server/api';
import { serialisePolicyRow } from '@/server/protection';

/**
 * Buying protection, in two steps.
 *
 * **POST** prices the cover, writes the policy as unpaid, and returns two
 * ERC-20 transfers for the participant to sign — the contribution to the pool
 * and the fee to FLT, separately, so the two amounts never share an address.
 *
 * **PUT** activates the policy once both transfers are verified on-chain. The
 * verification reads the receipts and checks token, sender, recipient and
 * amount; a browser claiming payment is not payment.
 *
 * FLT signs nothing and holds nothing at any point.
 */
const prepareSchema = z.object({
  kind: z.nativeEnum(ProtectionPolicyKind),
  symbol: z.string().trim().min(1).max(24),
  side: z.enum(['LONG', 'SHORT']),
  usdNotional: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'Must be a positive dollar amount'),
  leverage: z.coerce.number().int().min(1).max(100),
  percentile: z.coerce.number().gt(0.5).lt(1).optional(),
  horizonDays: z.coerce.number().int().min(1).max(365).optional(),
});

export const POST = handler(
  { schema: prepareSchema, rateLimit: { rule: RateLimits.QUOTE, scope: 'protection-purchase' } },
  async ({ user, body }) => {
    assertPerpsEnabled();

    const wallet = await resolveTradingWallet(prisma, user.id);

    const prepared = await preparePurchase(
      perpVenue(),
      { user, wallet },
      {
        kind: body.kind,
        symbol: body.symbol,
        side: body.side,
        usdNotional: new Decimal(body.usdNotional),
        leverage: body.leverage,
        percentile: body.percentile,
        horizonDays: body.horizonDays,
      },
    );

    return {
      policyId: prepared.policyId,
      premium: {
        contribution: prepared.quote.premium.contribution.toFixed(),
        operatorFee: prepared.quote.premium.operatorFee.toFixed(),
        total: prepared.quote.premium.totalPremium.toFixed(),
        operatorFeeBps: prepared.quote.premium.operatorFeeBps,
      },
      cover: {
        boundary: prepared.quote.boundary.toFixed(),
        percentile: String(prepared.quote.percentile),
        horizonDays: prepared.quote.horizonDays.toFixed(),
      },
      /** Sign these from your wallet. FLT cannot broadcast them. */
      transfers: prepared.transfers,
      note: prepared.note,
    };
  },
);

const confirmSchema = z.object({
  policyId: z.string().trim().min(1),
  poolTxHash: z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/, 'Not a transaction hash'),
  operatorTxHash: z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/, 'Not a transaction hash'),
});

export const PUT = handler({ schema: confirmSchema }, async ({ user, body }) => {
  assertPerpsEnabled();

  const policy = await confirmPurchase(body.policyId, user, {
    poolTxHash: body.poolTxHash,
    operatorTxHash: body.operatorTxHash,
  });

  return {
    policy: serialisePolicyRow(policy),
    note: 'Both transfers verified on-chain. Cover is active from now.',
  };
});
