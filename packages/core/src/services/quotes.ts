import {
  ActorType,
  QuoteStatus,
  type Quote,
  type Token,
  type User,
  type Wallet,
  prisma,
} from '@flt/db';
import { env } from '@flt/config';
import {
  NoLiquidityError,
  PriceImpactTooHighError,
  QuoteExpiredError,
  TokenDisabledError,
  ValidationError,
  WalletNotVerifiedError,
} from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal, differenceInBps, toDecimal } from '../domain/money';
import { addressesEqual, checksumAddress } from '../domain/address';
import { assertMayTrade } from './kyc';
import { calldataHash } from './crypto/hashing';
import { AuditAction, audit } from './audit';
import { resolveFee, type ResolvedFee } from './fees';
import type { DEXRouter, FirmQuote, IntegratorFee } from '../ports/dex';
import type { RiskEngine } from '../risk/types';

/**
 * Quote construction.
 *
 * This service owns the whole "what will this trade cost me?" answer, and it is
 * deliberately the only place that answer is assembled. The route adapter
 * reports what the venue said; everything the user is asked to judge — impact,
 * fee, floor, expiry — is computed and persisted here, once.
 *
 * The output is a row containing the exact calldata the wallet will be asked to
 * sign. That row is the contract between us and the user: the review screen
 * renders it, and the monitor later checks that what was mined matches it.
 */

export interface QuoteContext {
  user: User;
  wallet: Wallet;
  sellToken: Token;
  buyToken: Token;
  /** Base units of the sell token. */
  sellAmount: string;
  slippageBps?: number;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

export interface QuoteResult {
  quote: Quote;
  fee: ResolvedFee;
  /** Non-blocking cautions to surface on the review screen. */
  warnings: QuoteWarning[];
}

export interface QuoteWarning {
  code: string;
  message: string;
}

/**
 * Notional used for the price-impact reference.
 *
 * A quote for a very small amount approximates the pool's marginal rate — the
 * price you would get if your trade were too small to move anything. Comparing
 * the real trade's rate against that is the standard way to express impact.
 *
 * One thousandth of the trade, floored so tiny trades still produce a usable
 * reference and ceilinged so enormous ones do not themselves move the pool.
 */
function referenceAmount(sellAmount: string, decimals: number): string {
  const amount = BigInt(sellAmount);
  const thousandth = amount / 1_000n;
  const floor = BigInt(10) ** BigInt(Math.max(0, decimals - 4));
  const candidate = thousandth > floor ? thousandth : floor;
  return (candidate >= amount ? amount : candidate).toString();
}

export async function createQuote(
  router: DEXRouter,
  risk: RiskEngine,
  context: QuoteContext,
): Promise<QuoteResult> {
  assertMayTrade(context.user);
  assertTradeable(context.sellToken);
  assertTradeable(context.buyToken);

  if (!context.wallet.verifiedAt) {
    throw new WalletNotVerifiedError();
  }
  if (context.wallet.userId !== context.user.id) {
    // Should be unreachable — the caller scopes the wallet query by user — but
    // the check is cheap and the failure mode is quoting against a stranger.
    throw new ValidationError('That wallet is not linked to this account');
  }
  if (context.sellToken.chainId !== context.buyToken.chainId) {
    throw new ValidationError('Cross-chain trades are not supported');
  }
  if (context.sellToken.chainId !== context.wallet.chainId) {
    throw new ValidationError('That wallet is not on the same chain as this pair');
  }
  if (addressesEqual(context.sellToken.address, context.buyToken.address)) {
    throw new ValidationError('Choose two different tokens');
  }
  if (BigInt(context.sellAmount) <= 0n) {
    throw new ValidationError('Enter an amount greater than zero');
  }

  const config = env();
  const chainId = context.sellToken.chainId;
  const slippageBps = context.slippageBps ?? config.DEFAULT_SLIPPAGE_BPS;
  const warnings: QuoteWarning[] = [];

  // The fee is taken in the buy token, so the user pays it out of what they
  // receive rather than out of what they are spending.
  const fee = await resolveFee(prisma, {
    chainId,
    accountType: context.user.accountType,
    feeTokenAddress: context.buyToken.address,
    referenceAmount: context.sellAmount,
  });

  const integratorFee: IntegratorFee | undefined =
    fee.bps > 0 && fee.recipientAddress
      ? {
          bps: fee.bps,
          recipientAddress: fee.recipientAddress,
          tokenAddress: context.buyToken.address,
        }
      : undefined;

  const quote = await router.getQuote({
    chainId,
    sellTokenAddress: context.sellToken.address,
    buyTokenAddress: context.buyToken.address,
    sellAmount: context.sellAmount,
    takerAddress: checksumAddress(context.wallet.address),
    slippageBps,
    ...(integratorFee ? { fee: integratorFee } : {}),
  });

  if (!quote.liquidityAvailable || BigInt(quote.buyAmount) <= 0n) {
    await recordRejection(context, 'NO_LIQUIDITY');
    throw new NoLiquidityError({
      sellToken: context.sellToken.symbol,
      buyToken: context.buyToken.symbol,
    });
  }

  const priceImpactBps = await computePriceImpact(router, context, quote, slippageBps);

  if (priceImpactBps !== null && priceImpactBps > config.MAX_PRICE_IMPACT_BPS) {
    await recordRejection(context, 'PRICE_IMPACT_TOO_HIGH', { priceImpactBps });
    throw new PriceImpactTooHighError(priceImpactBps, config.MAX_PRICE_IMPACT_BPS);
  }

  // Phase 2 extension point. NoopRiskEngine allows everything today; the call
  // exists so a real engine slots in without touching this path. See ADR 0003.
  const decision = await risk.assessTrade({
    userId: context.user.id,
    accountType: context.user.accountType,
    chainId,
    walletAddress: context.wallet.address,
    sellTokenAddress: context.sellToken.address,
    buyTokenAddress: context.buyToken.address,
    sellAmount: context.sellAmount,
    buyAmount: quote.buyAmount,
    priceImpactBps,
    notionalUsd: null,
  });

  if (decision.outcome === 'BLOCK') {
    await recordRejection(context, 'RISK_BLOCKED', { reasons: decision.reasons });
    throw new ValidationError(decision.message ?? 'This trade cannot be executed right now.');
  }
  if (decision.outcome === 'WARN' && decision.message) {
    warnings.push({ code: 'RISK_WARNING', message: decision.message });
  }

  collectWarnings(quote, context, warnings);

  const now = Date.now();
  const saved = await prisma.quote.create({
    data: {
      id: newId(),
      userId: context.user.id,
      walletId: context.wallet.id,
      chainId,
      providerSlug: router.meta.slug,
      providerRef: quote.providerRef,

      sellTokenAddress: context.sellToken.address,
      buyTokenAddress: context.buyToken.address,
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      minBuyAmount: quote.minBuyAmount,

      priceImpactBps,
      slippageBps,
      networkFeeNative: quote.estimatedNetworkFee,

      feeBps: fee.bps,
      feeBpsRequested: fee.requestedBps,
      feeAmount: quote.feeAmount,
      feeTokenAddress: quote.feeTokenAddress,
      feeConfigId: fee.config?.id ?? null,

      routeJson: quote.route ? (quote.route as never) : undefined,

      txTo: quote.transaction.to,
      txData: quote.transaction.data,
      txValue: quote.transaction.value,
      txGas: quote.transaction.gas,
      // The tamper check later compares the mined transaction against this.
      calldataHash: calldataHash(
        quote.transaction.to,
        quote.transaction.data,
        quote.transaction.value,
      ),

      allowanceTarget: quote.allowanceTarget,
      allowanceNeeded: quote.allowanceNeeded,

      takerAddress: checksumAddress(context.wallet.address),
      status: QuoteStatus.ACTIVE,
      expiresAt: new Date(now + config.QUOTE_TTL_SECONDS * 1_000),
    },
  });

  await audit(prisma, {
    action: AuditAction.QUOTE_REQUESTED,
    entityType: 'Quote',
    entityId: saved.id,
    actorType: ActorType.USER,
    actorUserId: context.user.id,
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    requestId: context.requestId ?? null,
    after: {
      provider: router.meta.slug,
      sellToken: context.sellToken.symbol,
      buyToken: context.buyToken.symbol,
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      priceImpactBps,
      feeBps: fee.bps,
    },
  });

  return { quote: saved, fee, warnings };
}

/**
 * Estimates price impact against a small reference trade.
 *
 * Returns the venue's own number when it reports one. 0x Swap API v2 does not,
 * so on that path this is our estimate — and the interface labels it as an
 * estimate rather than presenting it as a measurement.
 *
 * Returns null rather than a guess if the reference quote fails: showing "—"
 * is honest, showing "0.00%" would be a claim we cannot support.
 */
async function computePriceImpact(
  router: DEXRouter,
  context: QuoteContext,
  quote: FirmQuote,
  slippageBps: number,
): Promise<number | null> {
  if (quote.priceImpactBps !== null) return quote.priceImpactBps;

  const reference = referenceAmount(context.sellAmount, context.sellToken.decimals);
  if (BigInt(reference) >= BigInt(context.sellAmount)) {
    // The trade is already at or below reference size, so there is nothing to
    // compare against and impact is negligible by construction.
    return 0;
  }

  try {
    const indicative = await router.getIndicativePrice({
      chainId: context.sellToken.chainId,
      sellTokenAddress: context.sellToken.address,
      buyTokenAddress: context.buyToken.address,
      sellAmount: reference,
      slippageBps,
    });

    if (!indicative.liquidityAvailable || BigInt(indicative.buyAmount) <= 0n) return null;

    const referenceRate = rate(
      indicative.sellAmount,
      indicative.buyAmount,
      context.sellToken.decimals,
      context.buyToken.decimals,
    );
    const executionRate = rate(
      quote.sellAmount,
      quote.buyAmount,
      context.sellToken.decimals,
      context.buyToken.decimals,
    );

    if (referenceRate.isZero()) return null;
    return differenceInBps(referenceRate, executionRate);
  } catch {
    // A failed reference quote must not fail the real one.
    return null;
  }
}

/** Buy tokens per sell token, decimal-normalized so the ratio is meaningful. */
function rate(
  sellAmount: string,
  buyAmount: string,
  sellDecimals: number,
  buyDecimals: number,
): Decimal {
  const sold = toDecimal(sellAmount, sellDecimals);
  if (sold.isZero()) return new Decimal(0);
  return toDecimal(buyAmount, buyDecimals).dividedBy(sold);
}

function collectWarnings(quote: FirmQuote, context: QuoteContext, warnings: QuoteWarning[]): void {
  if (quote.simulationIncomplete) {
    warnings.push({
      code: 'SIMULATION_INCOMPLETE',
      message:
        'The routing provider could not fully simulate this trade, so the expected output is less certain than usual.',
    });
  }

  const buyTax = quote.tokenTax?.buy.buyTaxBps ?? 0;
  const sellTax = quote.tokenTax?.sell.sellTaxBps ?? 0;

  if (buyTax > 0 || sellTax > 0) {
    warnings.push({
      code: 'TOKEN_TRANSFER_TAX',
      message: `This pair includes a token that charges a transfer fee (${((buyTax + sellTax) / 100).toFixed(2)}%). You will receive less than the quoted amount.`,
    });
  }

  if (context.buyToken.verificationTier === 'UNVERIFIED') {
    warnings.push({
      code: 'TOKEN_UNVERIFIED',
      message: `${context.buyToken.symbol} has not been reviewed by FLT. Check the contract address before trading.`,
    });
  }
}

async function recordRejection(
  context: QuoteContext,
  reason: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await audit(prisma, {
    action: AuditAction.QUOTE_REJECTED,
    entityType: 'Quote',
    entityId: null,
    actorType: ActorType.USER,
    actorUserId: context.user.id,
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    requestId: context.requestId ?? null,
    after: {
      reason,
      sellToken: context.sellToken.symbol,
      buyToken: context.buyToken.symbol,
      sellAmount: context.sellAmount,
      ...detail,
    },
  });
}

function assertTradeable(token: Token): void {
  if (!token.isEnabled) {
    throw new TokenDisabledError(token.symbol, token.disabledReason);
  }
}

/** Loads an active quote, enforcing ownership and expiry. */
export async function loadActiveQuote(quoteId: string, userId: string): Promise<Quote> {
  const quote = await prisma.quote.findFirst({ where: { id: quoteId, userId } });
  if (!quote) throw new QuoteExpiredError(quoteId);

  if (quote.status !== QuoteStatus.ACTIVE) throw new QuoteExpiredError(quoteId);
  if (quote.expiresAt.getTime() <= Date.now()) {
    await prisma.quote.updateMany({
      where: { id: quote.id, status: QuoteStatus.ACTIVE },
      data: { status: QuoteStatus.EXPIRED },
    });
    throw new QuoteExpiredError(quoteId);
  }

  return quote;
}

/** Housekeeping for the worker: closes quotes nobody signed. */
export async function expireStaleQuotes(): Promise<number> {
  const result = await prisma.quote.updateMany({
    where: { status: QuoteStatus.ACTIVE, expiresAt: { lt: new Date() } },
    data: { status: QuoteStatus.EXPIRED },
  });
  return result.count;
}
