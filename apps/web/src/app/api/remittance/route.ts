import { z } from 'zod';
import {
  confirmRemittanceTransfer,
  createRemittance,
  listRemittancesForUser,
  quoteRemittance,
} from '@flt/core/services/remittance';
import { resolveRemittanceSettings } from '@flt/core/services/platform-settings';
import { handler } from '@/server/api';

/**
 * Crypto-to-fiat remittance.
 *
 * GET  the corridor's terms and this account's own transfers.
 * POST create a transfer and get the stablecoin transfer that funds it.
 * PUT  confirm that funding, verified against the mined receipt.
 *
 * There is no endpoint that pays anybody. The outbound leg is an operator
 * action in the admin panel, because EVC Plus gives FLT no way to send money
 * programmatically — and no route here should look as though it can.
 */
const decimal = z.string().trim().regex(/^\d+(\.\d+)?$/, 'Enter an amount in dollars');

export const GET = handler({}, async ({ user, request }) => {
  const url = new URL(request.url);
  const amount = url.searchParams.get('amount');

  const [settings, orders] = await Promise.all([
    resolveRemittanceSettings(),
    listRemittancesForUser(user.id),
  ]);

  // A quote is only attempted when an amount is asked for, so simply opening
  // the page does not surface a validation error about a figure nobody typed.
  const quote =
    settings.enabled && amount && /^\d+(\.\d+)?$/.test(amount)
      ? await quoteRemittance(amount).catch(() => null)
      : null;

  return {
    available: settings.enabled,
    terms: {
      feeBps: settings.feeBps,
      fxRate: settings.fxRate,
      minUsd: settings.minUsd,
      maxUsd: settings.maxUsd,
      currency: settings.currency,
    },
    quote,
    orders: orders.map((order) => ({
      id: order.id,
      status: order.status,
      sendAmountUsd: order.sendAmountUsd,
      payoutAmount: order.payoutAmount,
      payoutCurrency: order.payoutCurrency,
      beneficiaryName: order.beneficiaryName,
      beneficiaryPhone: order.beneficiaryPhone,
      payoutReference: order.payoutReference,
      reviewNote: order.reviewNote,
      createdAt: order.createdAt,
      expiresAt: order.expiresAt,
    })),
  };
});

export const POST = handler(
  {
    schema: z.object({
      amountUsd: decimal,
      beneficiaryName: z.string().trim().min(2).max(120),
      beneficiaryPhone: z.string().trim().min(7).max(24),
      beneficiaryRelationship: z.string().trim().min(2).max(80),
      purpose: z.string().trim().min(3).max(200),
      walletId: z.string().trim().min(1),
    }),
  },
  async ({ user, body }) => {
    const prepared = await createRemittance(user, body);
    return {
      orderId: prepared.orderId,
      quote: prepared.quote,
      transfer: prepared.transfer,
      expiresAt: prepared.expiresAt,
    };
  },
);

export const PUT = handler(
  {
    schema: z.object({
      orderId: z.string().trim().min(1),
      txHash: z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/, 'Not a transaction hash'),
    }),
  },
  async ({ user, body }) => {
    const order = await confirmRemittanceTransfer(user, body.orderId, body.txHash);
    return {
      status: order.status,
      payoutAmount: order.payoutAmount,
      payoutCurrency: order.payoutCurrency,
    };
  },
);
