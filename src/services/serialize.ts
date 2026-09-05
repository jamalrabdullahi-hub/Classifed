import type {
  Asset,
  Deposit,
  Order,
  Trade,
  Withdrawal,
} from '@prisma/client';

/**
 * API serialization.
 *
 * Prisma returns Decimal objects, which JSON.stringify would render as
 * `{"s":1,"e":2,"d":[100]}`. Every monetary field is converted to a plain
 * decimal string here so the wire format is unambiguous and never a float.
 */

export function serializeOrder(
  order: Order & { asset?: Asset | null; trades?: Trade[] },
) {
  return {
    id: order.id,
    status: order.status,
    side: order.side,
    assetSymbol: order.asset?.symbol ?? null,
    requestedFiatAmount: order.requestedFiatAmount.toString(),
    requestedCryptoAmount: order.requestedCryptoAmount.toString(),
    filledFiatAmount: order.filledFiatAmount.toString(),
    filledCryptoAmount: order.filledCryptoAmount.toString(),
    refundedFiatAmount: order.refundedFiatAmount.toString(),
    brokerageFee: order.brokerageFee.toString(),
    providerFee: order.providerFee.toString(),
    executionPrice: order.executionPrice?.toString() ?? null,
    providerOrderId: order.providerOrderId,
    failureReason: order.failureReason,
    // The venue is recorded for audit but is an implementation detail of the
    // book; the customer sees it only as an execution note.
    executionVenue: order.executionVenue,
    priceImpactBps: order.priceImpactBps,
    createdAt: order.createdAt.toISOString(),
    executedAt: order.executedAt?.toISOString() ?? null,
    settledAt: order.settledAt?.toISOString() ?? null,
    trades: (order.trades ?? []).map((trade) => ({
      id: trade.id,
      sequence: trade.sequence,
      quantity: trade.quantity.toString(),
      executedPrice: trade.executedPrice.toString(),
      fiatValue: trade.fiatValue.toString(),
      providerFee: trade.providerFee.toString(),
      providerTradeId: trade.providerTradeId,
      executedAt: trade.executedAt.toISOString(),
    })),
  };
}

export function serializeDeposit(deposit: Deposit) {
  return {
    id: deposit.id,
    status: deposit.status,
    provider: deposit.provider,
    currency: deposit.currency,
    amount: deposit.amount.toString(),
    providerFee: deposit.providerFee.toString(),
    netAmount: deposit.netAmount.toString(),
    reference: deposit.reference,
    externalId: deposit.externalId,
    failureReason: deposit.failureReason,
    createdAt: deposit.createdAt.toISOString(),
    creditedAt: deposit.creditedAt?.toISOString() ?? null,
  };
}

export function serializeWithdrawal(
  withdrawal: Withdrawal & { asset?: Asset | null },
) {
  return {
    id: withdrawal.id,
    status: withdrawal.status,
    kind: withdrawal.kind,
    assetSymbol: withdrawal.asset?.symbol ?? null,
    amount: withdrawal.amount.toString(),
    brokerageFee: withdrawal.brokerageFee.toString(),
    networkFee: withdrawal.networkFee.toString(),
    netAmount: withdrawal.netAmount.toString(),
    destinationAddress: withdrawal.destinationAddress,
    network: withdrawal.network,
    txHash: withdrawal.txHash,
    confirmations: withdrawal.confirmations,
    requiredConfirmations: withdrawal.requiredConfirmations,
    failureReason: withdrawal.failureReason,
    createdAt: withdrawal.createdAt.toISOString(),
    completedAt: withdrawal.completedAt?.toISOString() ?? null,
  };
}
