import type { Asset, ExecutionVenueKind as VenueKind, OrderSide, Quote } from '@prisma/client';
import {
  Decimal,
  applyBps,
  roundDeliverable,
  roundFee,
  USD_SCALE,
} from '../domain/money';
import {
  NotFoundError,
  QuoteAlreadyUsedError,
  QuoteExpiredError,
  ValidationError,
} from '../domain/errors';
import { newId } from '../domain/id';
import {
  assertTradable,
  assertWithinTierSize,
  gatherVenueQuotes,
  getReferenceRate,
  selectBestVenue,
  type SourcingRequest,
} from './execution';
import { env } from '../server/env';
import type { DbClient } from '../server/db';
import { assertWithinTradeLimits, getCustomerStanding } from './limits';

/**
 * Pricing.
 *
 * Two rules that the rest of the system leans on:
 *   1. A quote is priced entirely server-side from a live venue price. The client
 *      supplies an amount and a side; every other number is ours.
 *   2. A quote expires, and is single-use. `consumeQuote` enforces both under a
 *      conditional update, so two concurrent orders cannot share one quote.
 */

export interface QuoteBreakdown {
  id: string;
  assetSymbol: string;
  side: OrderSide;
  fiatAmount: string;
  cryptoAmount: string;
  exchangeRate: string;
  brokerageFee: string;
  networkFee: string;
  totalCustomerCost: string;
  /** The floor. If execution cannot beat this, the order fails and refunds. */
  minOutputAmount: string;
  /** Price impact of sourcing this size, in basis points. */
  priceImpactBps: number;
  expiresAt: Date;
  expiresInSeconds: number;
}

export interface CreateQuoteInput {
  userId: string;
  assetSymbol: string;
  side: OrderSide;
  /** BUY: the USD the customer wants to spend. */
  fiatAmount?: string;
  /** SELL: the crypto the customer wants to sell. */
  cryptoAmount?: string;
}

export async function createQuote(
  db: DbClient,
  input: CreateQuoteInput,
): Promise<{ quote: Quote; breakdown: QuoteBreakdown }> {
  const asset = await db.asset.findUnique({ where: { symbol: input.assetSymbol } });
  if (!asset) throw new NotFoundError(`Asset ${input.assetSymbol}`);
  if (asset.kind !== 'CRYPTO') {
    throw new ValidationError('Quotes are only available for crypto assets');
  }
  // Liquidity tier decides whether we will quote this at all, and instantly.
  assertTradable(asset);

  const usdAsset = await db.asset.findUnique({ where: { symbol: 'USD' } });
  if (!usdAsset) throw new NotFoundError('Asset USD');

  const standing = await getCustomerStanding(db, input.userId);

  // Exactly one side of the amount may be supplied, and it must match the side.
  if (input.side === 'BUY' && !input.fiatAmount) {
    throw new ValidationError('A buy quote requires a USD amount');
  }
  if (input.side === 'SELL' && !input.cryptoAmount) {
    throw new ValidationError('A sell quote requires a crypto amount');
  }

  const requestedFiat = input.fiatAmount ? parseAmount(input.fiatAmount, 'USD amount') : undefined;
  const requestedCrypto = input.cryptoAmount
    ? parseAmount(input.cryptoAmount, `${asset.symbol} amount`)
    : undefined;

  // Price from a venue that will actually serve us: on-chain first, OTC second.
  const reference = await getReferenceRate(db, {
    asset,
    side: input.side,
    amountIn: input.side === 'BUY' ? requestedFiat! : requestedCrypto!,
  });
  const providerRate = reference.rate;

  const breakdown =
    input.side === 'BUY'
      ? priceBuy({ asset, fiatAmount: requestedFiat!, rate: providerRate })
      : priceSell({ asset, cryptoAmount: requestedCrypto!, rate: providerRate });

  // Trade limits are checked against the USD notional, whichever side we are on.
  await assertWithinTradeLimits(db, standing, breakdown.fiatAmount);
  assertTradeSize(asset, breakdown.fiatAmount);
  assertWithinTierSize(asset, breakdown.fiatAmount);

  // Ask the router what sourcing this size would actually cost, so the price
  // impact the customer sees is the impact they would really incur — and so a
  // size that no venue can serve is refused now, not after they have committed.
  const sourcing = await previewSourcing(db, {
    asset,
    usdAsset,
    side: input.side,
    breakdown,
  });

  const ttl = env().QUOTE_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  const quote = await db.quote.create({
    data: {
      id: newId(),
      userId: input.userId,
      assetId: asset.id,
      side: input.side,
      fiatAmount: breakdown.fiatAmount.toFixed(),
      cryptoAmount: breakdown.cryptoAmount.toFixed(),
      exchangeRate: breakdown.effectiveRate.toFixed(),
      brokerageFee: breakdown.brokerageFee.toFixed(),
      networkFee: '0',
      totalCustomerCost: breakdown.totalCustomerCost.toFixed(),
      providerRate: providerRate.toFixed(),
      providerQuoteRef: reference.quoteRef ?? null,
      minOutputAmount: sourcing.minOutput.toFixed(),
      priceImpactBps: sourcing.priceImpactBps,
      indicativeVenue: sourcing.venueKind,
      status: 'ACTIVE',
      expiresAt,
    },
  });

  return { quote, breakdown: toBreakdown(quote, asset.symbol) };
}

/**
 * Dry-run the router at quote time.
 *
 * This is what makes the quoted price honest: the customer is shown the impact
 * of sourcing *their* size, and the floor we will enforce at execution is
 * derived here rather than invented later. Nothing is submitted; no funds move.
 */
async function previewSourcing(
  db: DbClient,
  params: {
    asset: Asset;
    usdAsset: Asset;
    side: OrderSide;
    breakdown: PricedQuote;
  },
): Promise<{ minOutput: Decimal; priceImpactBps: number; venueKind: VenueKind | null }> {
  const tolerance = env().EXECUTION_SLIPPAGE_TOLERANCE_BPS;

  // The floor: what we quoted, less the tolerance we are willing to absorb.
  const quotedOutput =
    params.side === 'BUY' ? params.breakdown.cryptoAmount : params.breakdown.totalCustomerCost;
  const minOutput = quotedOutput
    .times(new Decimal(10_000 - tolerance).dividedBy(10_000))
    .toDecimalPlaces(
      params.side === 'BUY' ? params.asset.quoteScale : USD_SCALE,
      Decimal.ROUND_DOWN,
    );

  const request: SourcingRequest = {
    orderId: 'preview',
    asset: params.asset,
    usdAsset: params.usdAsset,
    side: params.side,
    amountIn:
      params.side === 'BUY'
        ? params.breakdown.fiatAmount.minus(params.breakdown.brokerageFee)
        : params.breakdown.cryptoAmount,
    expectedOutput: quotedOutput,
    minOutput,
    notionalUsd: params.breakdown.fiatAmount,
  };

  const quotes = await gatherVenueQuotes(db, request);
  const best = selectBestVenue(quotes);

  if (!best) {
    const reasons = quotes
      .map((q) => q.rejectedReason)
      .filter(Boolean)
      .join('; ');
    throw new ValidationError(
      `We cannot source ${params.asset.symbol} at this size right now. Try a smaller amount.`,
      { venues: reasons },
    );
  }

  return { minOutput, priceImpactBps: best.priceImpactBps, venueKind: best.venueKind };
}

interface PricedQuote {
  fiatAmount: Decimal;
  cryptoAmount: Decimal;
  effectiveRate: Decimal;
  brokerageFee: Decimal;
  totalCustomerCost: Decimal;
}

/**
 * BUY: the customer names a USD amount. Our fee comes out of it first; the
 * remainder buys crypto. Crypto is rounded DOWN to the asset's settlement scale
 * so we never promise a fraction we cannot deliver.
 */
export function priceBuy(params: {
  asset: Pick<Asset, 'quoteScale' | 'brokerageFeeBps'>;
  fiatAmount: Decimal;
  rate: Decimal;
}): PricedQuote {
  const fiatAmount = params.fiatAmount.toDecimalPlaces(USD_SCALE, Decimal.ROUND_DOWN);
  const brokerageFee = roundFee(applyBps(fiatAmount, params.asset.brokerageFeeBps), USD_SCALE);
  const spendable = fiatAmount.minus(brokerageFee);

  if (!spendable.isPositive()) {
    throw new ValidationError('The amount is too small to cover the brokerage fee');
  }

  const cryptoAmount = roundDeliverable(
    spendable.dividedBy(params.rate),
    params.asset.quoteScale,
  );
  if (!cryptoAmount.isPositive()) {
    throw new ValidationError('The amount is too small to buy a deliverable quantity');
  }

  return {
    fiatAmount,
    cryptoAmount,
    // What the customer effectively pays per unit, fee included.
    effectiveRate: fiatAmount.dividedBy(cryptoAmount).toDecimalPlaces(18),
    brokerageFee,
    // For a buy, the total cost is simply the USD amount they named.
    totalCustomerCost: fiatAmount,
  };
}

/**
 * SELL: the customer names a crypto amount. Gross proceeds are computed at the
 * venue rate, our fee is deducted, and the customer receives the remainder,
 * rounded DOWN to cents.
 */
export function priceSell(params: {
  asset: Pick<Asset, 'quoteScale' | 'brokerageFeeBps'>;
  cryptoAmount: Decimal;
  rate: Decimal;
}): PricedQuote {
  const cryptoAmount = params.cryptoAmount.toDecimalPlaces(
    params.asset.quoteScale,
    Decimal.ROUND_DOWN,
  );
  if (!cryptoAmount.isPositive()) {
    throw new ValidationError('The amount is below the smallest tradable quantity');
  }

  const grossProceeds = cryptoAmount.times(params.rate).toDecimalPlaces(
    USD_SCALE,
    Decimal.ROUND_DOWN,
  );
  const brokerageFee = roundFee(applyBps(grossProceeds, params.asset.brokerageFeeBps), USD_SCALE);
  const netProceeds = grossProceeds.minus(brokerageFee);

  if (!netProceeds.isPositive()) {
    throw new ValidationError('The proceeds would not cover the brokerage fee');
  }

  return {
    fiatAmount: grossProceeds,
    cryptoAmount,
    effectiveRate: netProceeds.dividedBy(cryptoAmount).toDecimalPlaces(18),
    brokerageFee,
    // For a sell, this is what the customer actually receives.
    totalCustomerCost: netProceeds,
  };
}

function assertTradeSize(asset: Asset, fiatAmount: Decimal): void {
  const min = new Decimal(asset.minTradeUsd.toString());
  const max = new Decimal(asset.maxTradeUsd.toString());
  if (fiatAmount.lt(min)) {
    throw new ValidationError(`The minimum ${asset.symbol} order is $${min.toFixed(2)}`);
  }
  if (max.gt(0) && fiatAmount.gt(max)) {
    throw new ValidationError(`The maximum ${asset.symbol} order is $${max.toFixed(2)}`);
  }
}

function parseAmount(raw: string, label: string): Decimal {
  let value: Decimal;
  try {
    value = new Decimal(raw);
  } catch {
    throw new ValidationError(`${label} is not a valid number`);
  }
  if (!value.isFinite() || !value.isPositive()) {
    throw new ValidationError(`${label} must be greater than zero`);
  }
  if (value.decimalPlaces() > 18) {
    throw new ValidationError(`${label} has too many decimal places`);
  }
  return value;
}

export function toBreakdown(quote: Quote, assetSymbol: string): QuoteBreakdown {
  return {
    id: quote.id,
    assetSymbol,
    side: quote.side,
    fiatAmount: quote.fiatAmount.toString(),
    cryptoAmount: quote.cryptoAmount.toString(),
    exchangeRate: quote.exchangeRate.toString(),
    brokerageFee: quote.brokerageFee.toString(),
    networkFee: quote.networkFee.toString(),
    totalCustomerCost: quote.totalCustomerCost.toString(),
    minOutputAmount: quote.minOutputAmount.toString(),
    priceImpactBps: quote.priceImpactBps,
    expiresAt: quote.expiresAt,
    expiresInSeconds: Math.max(
      0,
      Math.ceil((quote.expiresAt.getTime() - Date.now()) / 1000),
    ),
  };
}

export function isExpired(quote: Pick<Quote, 'expiresAt'>, now = new Date()): boolean {
  return quote.expiresAt.getTime() <= now.getTime();
}

/**
 * Claim a quote for an order.
 *
 * The conditional UPDATE is the whole point: status must still be ACTIVE and the
 * expiry must still be in the future at the moment of the write. Two concurrent
 * orders cannot both win, and a quote cannot be used a millisecond after it dies.
 */
export async function consumeQuote(
  db: DbClient,
  params: { quoteId: string; userId: string; now?: Date },
): Promise<Quote> {
  const now = params.now ?? new Date();

  const quote = await db.quote.findUnique({ where: { id: params.quoteId } });
  if (!quote) throw new NotFoundError('Quote');

  // Do not disclose that the quote exists to a customer it does not belong to.
  if (quote.userId !== params.userId) throw new NotFoundError('Quote');

  if (quote.status === 'CONSUMED') throw new QuoteAlreadyUsedError(quote.id);
  if (quote.status === 'EXPIRED' || isExpired(quote, now)) {
    await db.quote.updateMany({
      where: { id: quote.id, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });
    throw new QuoteExpiredError(quote.id);
  }

  const claimed = await db.quote.updateMany({
    where: { id: quote.id, status: 'ACTIVE', expiresAt: { gt: now } },
    data: { status: 'CONSUMED', consumedAt: now },
  });
  if (claimed.count === 0) {
    // Lost the race, or it expired between the read and the write.
    const current = await db.quote.findUnique({ where: { id: quote.id } });
    if (current?.status === 'CONSUMED') throw new QuoteAlreadyUsedError(quote.id);
    throw new QuoteExpiredError(quote.id);
  }

  return { ...quote, status: 'CONSUMED', consumedAt: now };
}

/** Housekeeping: mark quotes that timed out without being used. */
export async function expireStaleQuotes(db: DbClient, now = new Date()): Promise<number> {
  const result = await db.quote.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  });
  return result.count;
}
