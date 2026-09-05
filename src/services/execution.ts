import type { Asset, ExecutionVenueKind } from '@prisma/client';
import { Decimal, USD_SCALE, normalizeZero } from '../domain/money';
import { ForbiddenError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import type { DexRoute } from '../providers/dex/types';
import { dexProvider, liquidityProvider } from '../providers/registry';
import { env } from '../server/env';
import { prisma, type DbClient, type Tx } from '../server/db';
import { AuditAction, audit, type AuditContext } from './audit';
import { approvedSlugs, requireApprovedProtocol } from './protocols';
import { checkOutbound, hotWalletFor, inventoryPosition } from './treasury';

/**
 * The execution router.
 *
 * Given "we need X of asset A", it decides HOW to obtain it, considering every
 * venue that is available and permitted, and records what it considered — the
 * rejections as well as the choice — so best execution is auditable rather than
 * merely asserted.
 *
 * Order of preference is not hardcoded by name; venues are ranked on net output
 * after every cost. Inventory usually wins because it has no gas and no impact,
 * which is exactly the incentive we want.
 *
 * Hard rules, applied in order, before anything is compared:
 *   1. The asset's liquidity tier must permit automatic execution at all.
 *   2. Price impact must be within the asset's cap.
 *   3. The protocol must be on the whitelist.
 *   4. The trade must be within the hot wallet's outbound limits.
 *   5. Simulation must predict success.
 *   6. The fill must beat the customer's promised floor, or it does not happen.
 */

export interface SourcingRequest {
  orderId: string;
  /** Asset we need to acquire (BUY) or dispose of (SELL). */
  asset: Asset;
  usdAsset: Asset;
  side: 'BUY' | 'SELL';
  /** For a BUY: the USD we are willing to spend. For a SELL: crypto to sell. */
  amountIn: Decimal;
  /** What the quote promised. Inventory can deliver exactly this. */
  expectedOutput: Decimal;
  /** The floor the customer was quoted. Execution below this must not settle. */
  minOutput: Decimal;
  /** USD notional, for limit checks. */
  notionalUsd: Decimal;
}

export interface VenueQuoteResult {
  venueKind: ExecutionVenueKind;
  venueName: string;
  protocolSlug?: string;
  protocolId?: string;
  /** Expected output in the destination asset. */
  expectedOutput: Decimal;
  /** Expected output after gas, which is how venues are actually compared. */
  netOutput: Decimal;
  priceImpactBps: number;
  protocolFee: Decimal;
  gasFeeNative: Decimal;
  gasFeeUsd: Decimal;
  route?: DexRoute;
  /** Set when this venue was considered and refused. */
  rejectedReason?: string;
}

export interface SourcingResult {
  venueKind: ExecutionVenueKind;
  venueName: string;
  /** Output actually obtained. */
  output: Decimal;
  /** Input actually consumed. */
  input: Decimal;
  priceImpactBps: number;
  gasFeeNative: Decimal;
  gasAssetSymbol?: string;
  protocolFee: Decimal;
  protocolId?: string;
  txHash?: string;
  externalRef?: string;
  /** True when the fill came from stock and no venue was touched. */
  fromInventory: boolean;
  attemptId: string;
}

/**
 * Tier policy. TIER_4 is never tradable; TIER_3 needs a human; TIER_1 and 2 run
 * automatically within their caps.
 */
export function assertTierAllowsAutomaticExecution(asset: Asset): void {
  if (asset.liquidityTier === 'TIER_4' || asset.executionMode === 'UNAVAILABLE') {
    throw new ValidationError(
      `${asset.symbol} is not available for trading`,
      { symbol: asset.symbol, tier: asset.liquidityTier },
    );
  }
  if (asset.executionMode === 'MANUAL' || asset.executionMode === 'RFQ') {
    throw new ValidationError(
      `${asset.symbol} is quoted on request rather than instantly. Contact support for a price.`,
      { symbol: asset.symbol, tier: asset.liquidityTier, mode: asset.executionMode },
    );
  }
}

/** Size caps that scale with how thin the asset is. */
export function assertWithinTierSize(asset: Asset, notionalUsd: Decimal): void {
  const dexCap = new Decimal(asset.maxDexTradeUsd.toString());
  if (dexCap.gt(0) && notionalUsd.gt(dexCap)) {
    throw new ValidationError(
      `The largest ${asset.symbol} order we can source right now is $${dexCap.toFixed(2)}`,
      { symbol: asset.symbol, cap: dexCap.toFixed(2) },
    );
  }
}

/**
 * Gather quotes from every venue that could serve this request.
 *
 * Venues that cannot serve it are still returned, carrying `rejectedReason`, so
 * the ExecutionAttempt rows explain why each was passed over.
 */
export async function gatherVenueQuotes(
  db: DbClient,
  request: SourcingRequest,
): Promise<VenueQuoteResult[]> {
  const results: VenueQuoteResult[] = [];

  // --- Inventory ------------------------------------------------------------
  results.push(await quoteInventory(db, request));

  // --- On-chain -------------------------------------------------------------
  results.push(...(await quoteDex(db, request)));

  // --- OTC ------------------------------------------------------------------
  results.push(await quoteOtc(request));

  return results;
}

async function quoteInventory(
  db: DbClient,
  request: SourcingRequest,
): Promise<VenueQuoteResult> {
  const base: VenueQuoteResult = {
    venueKind: 'INVENTORY',
    venueName: 'treasury',
    expectedOutput: new Decimal(0),
    netOutput: new Decimal(0),
    priceImpactBps: 0,
    protocolFee: new Decimal(0),
    gasFeeNative: new Decimal(0),
    gasFeeUsd: new Decimal(0),
  };

  // A SELL adds to inventory, so there is nothing to check — we can always
  // absorb crypto a customer hands us.
  if (request.side === 'SELL') {
    return {
      ...base,
      expectedOutput: request.expectedOutput,
      netOutput: request.expectedOutput,
    };
  }

  const position = await inventoryPosition(db, request.asset.id);
  const needed = request.expectedOutput;

  if (position.free.lt(needed)) {
    return {
      ...base,
      rejectedReason: `Free inventory ${position.free.toFixed()} ${request.asset.symbol} is short of the ${needed.toFixed()} required`,
    };
  }

  // Filling from stock costs no gas and moves no market, so it delivers exactly
  // what was quoted. That is why it almost always wins the ranking.
  return { ...base, expectedOutput: needed, netOutput: needed };
}

async function quoteDex(
  db: DbClient,
  request: SourcingRequest,
): Promise<VenueQuoteResult[]> {
  const chain = request.asset.chain;
  if (!chain) {
    return [
      {
        venueKind: 'DEX',
        venueName: 'dex',
        expectedOutput: new Decimal(0),
        netOutput: new Decimal(0),
        priceImpactBps: 0,
        protocolFee: new Decimal(0),
        gasFeeNative: new Decimal(0),
        gasFeeUsd: new Decimal(0),
        rejectedReason: `${request.asset.symbol} has no chain configured for on-chain sourcing`,
      },
    ];
  }

  const allowed = await approvedSlugs(db, chain);
  if (allowed.length === 0) {
    return [
      {
        venueKind: 'DEX',
        venueName: 'dex',
        expectedOutput: new Decimal(0),
        netOutput: new Decimal(0),
        priceImpactBps: 0,
        protocolFee: new Decimal(0),
        gasFeeNative: new Decimal(0),
        gasFeeUsd: new Decimal(0),
        rejectedReason: `No approved protocol on ${chain}`,
      },
    ];
  }

  // We swap our stablecoin inventory for the asset (BUY) or back (SELL).
  const stable = await db.asset.findUnique({ where: { symbol: STABLE_SYMBOL } });
  if (!stable) {
    throw new ValidationError(`Sourcing stablecoin ${STABLE_SYMBOL} is not configured`);
  }

  const fromSymbol = request.side === 'BUY' ? stable.symbol : request.asset.symbol;
  const toSymbol = request.side === 'BUY' ? request.asset.symbol : stable.symbol;

  let routes;
  try {
    routes = await dexProvider().getRoutes({
      chain,
      fromSymbol,
      toSymbol,
      amountIn: request.amountIn.toFixed(),
      allowedProtocols: allowed,
      maxPriceImpactBps: request.asset.maxPriceImpactBps,
    });
  } catch (error) {
    return [
      {
        venueKind: 'DEX',
        venueName: 'dex',
        expectedOutput: new Decimal(0),
        netOutput: new Decimal(0),
        priceImpactBps: 0,
        protocolFee: new Decimal(0),
        gasFeeNative: new Decimal(0),
        gasFeeUsd: new Decimal(0),
        rejectedReason: `Routing failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }

  if (routes.data.length === 0) {
    return [
      {
        venueKind: 'DEX',
        venueName: 'dex',
        expectedOutput: new Decimal(0),
        netOutput: new Decimal(0),
        priceImpactBps: 0,
        protocolFee: new Decimal(0),
        gasFeeNative: new Decimal(0),
        gasFeeUsd: new Decimal(0),
        rejectedReason: `No route within the ${request.asset.maxPriceImpactBps}bps impact cap`,
      },
    ];
  }

  const out: VenueQuoteResult[] = [];

  for (const route of routes.data) {
    const expectedOutput = new Decimal(route.expectedOut);
    const gasUsd = new Decimal(route.estimatedGasUsd);

    // Compare venues on output after gas, expressed in the output asset.
    const outputUsdPrice = request.notionalUsd.isZero()
      ? new Decimal(0)
      : request.notionalUsd.dividedBy(expectedOutput.isZero() ? new Decimal(1) : expectedOutput);
    const gasInOutputAsset = outputUsdPrice.isZero()
      ? new Decimal(0)
      : gasUsd.dividedBy(outputUsdPrice);
    const netOutput = normalizeZero(expectedOutput.minus(gasInOutputAsset));

    const result: VenueQuoteResult = {
      venueKind: 'DEX',
      venueName: route.protocolSlug,
      protocolSlug: route.protocolSlug,
      expectedOutput,
      netOutput,
      priceImpactBps: route.priceImpactBps,
      protocolFee: new Decimal(route.protocolFee),
      gasFeeNative: new Decimal(route.estimatedGasNative),
      gasFeeUsd: gasUsd,
      route,
    };

    // Whitelist. An aggregator proposing an unreviewed pool is refused here.
    try {
      const protocol = await requireApprovedProtocol(db, {
        slug: route.protocolSlug,
        chain,
        tradeUsd: request.notionalUsd,
      });
      result.protocolId = protocol.id;
    } catch (error) {
      result.rejectedReason =
        error instanceof Error ? error.message : 'Protocol not approved';
      out.push(result);
      continue;
    }

    if (route.priceImpactBps > request.asset.maxPriceImpactBps) {
      result.rejectedReason = `Price impact ${route.priceImpactBps}bps exceeds the ${request.asset.maxPriceImpactBps}bps cap`;
      out.push(result);
      continue;
    }

    if (netOutput.lt(request.minOutput)) {
      result.rejectedReason = `Net output ${netOutput.toFixed()} is below the ${request.minOutput.toFixed()} floor`;
      out.push(result);
      continue;
    }

    // Hot-wallet policy, checked before any submission.
    const outbound = await checkOutbound(db, {
      chain,
      valueUsd: request.notionalUsd,
    });
    if (!outbound.allowed) {
      result.rejectedReason = outbound.reason ?? 'Blocked by treasury policy';
      out.push(result);
      continue;
    }

    // Gas reserve. A route we cannot pay for is not a route — and discovering
    // that after submission means a stuck transaction and a customer waiting.
    const gasCheck = await hasGasFor(db, chain, new Decimal(route.estimatedGasNative));
    if (!gasCheck.ok) {
      result.rejectedReason = gasCheck.reason;
      out.push(result);
      continue;
    }

    out.push(result);
  }

  return out;
}

/**
 * Does the hot wallet hold enough of the chain's native asset to pay gas?
 *
 * Checked against FREE inventory, not the raw balance: native tokens a customer
 * is owed are not ours to burn on gas.
 */
async function hasGasFor(
  db: DbClient,
  chain: string,
  gasNative: Decimal,
): Promise<{ ok: boolean; reason?: string }> {
  const native = await db.asset.findFirst({
    where: { chain, isNativeAsset: true, isActive: true },
  });
  if (!native) {
    // No native asset configured for this chain, so we cannot reason about gas.
    return { ok: false, reason: `No native gas asset configured for ${chain}` };
  }

  const position = await inventoryPosition(db, native.id);
  if (position.free.lt(gasNative)) {
    return {
      ok: false,
      reason: `Insufficient ${native.symbol} for gas: need ${gasNative.toFixed()}, free ${position.free.toFixed()}`,
    };
  }
  return { ok: true };
}

async function quoteOtc(request: SourcingRequest): Promise<VenueQuoteResult> {
  const base: VenueQuoteResult = {
    venueKind: 'OTC',
    venueName: liquidityProvider().meta.name,
    expectedOutput: new Decimal(0),
    netOutput: new Decimal(0),
    priceImpactBps: 0,
    protocolFee: new Decimal(0),
    gasFeeNative: new Decimal(0),
    gasFeeUsd: new Decimal(0),
  };

  try {
    const quote = await liquidityProvider().getQuote({
      symbol: request.asset.symbol,
      quoteCurrency: 'USD',
      side: request.side,
      fiatAmount: request.side === 'BUY' ? request.amountIn.toFixed(USD_SCALE) : undefined,
      cryptoAmount: request.side === 'SELL' ? request.amountIn.toFixed() : undefined,
    });

    const output =
      request.side === 'BUY'
        ? new Decimal(quote.data.cryptoAmount)
        : new Decimal(quote.data.fiatAmount);
    const fee = new Decimal(quote.data.fee ?? '0');

    const result: VenueQuoteResult = {
      ...base,
      expectedOutput: output,
      netOutput: output,
      protocolFee: fee,
    };

    if (output.lt(request.minOutput)) {
      result.rejectedReason = `OTC output ${output.toFixed()} is below the ${request.minOutput.toFixed()} floor`;
    }
    return result;
  } catch (error) {
    return {
      ...base,
      // The realistic case for a Somali brokerage: the OTC desk simply will not
      // quote. That is a routing outcome, not a system failure.
      rejectedReason: `OTC unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Stablecoin the treasury swaps in and out of on-chain. */
export const STABLE_SYMBOL = 'USDC';

/**
 * Persist every venue considered, in rank order, as the best-execution record.
 */
export async function recordAttempts(
  db: Tx,
  orderId: string,
  request: SourcingRequest,
  quotes: VenueQuoteResult[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const [index, quote] of quotes.entries()) {
    const id = newId();
    await db.executionAttempt.create({
      data: {
        id,
        orderId,
        sequence: index + 1,
        venueKind: quote.venueKind,
        venueName: quote.venueName,
        protocolId: quote.protocolId ?? null,
        requestedAmount: request.amountIn.toFixed(),
        requestedAsset: request.side === 'BUY' ? request.usdAsset.symbol : request.asset.symbol,
        quotedOutput: quote.expectedOutput.toFixed(),
        minOutput: request.minOutput.toFixed(),
        netOutput: quote.netOutput.toFixed(),
        priceImpactBps: quote.priceImpactBps,
        protocolFee: quote.protocolFee.toFixed(),
        gasFeeNative: quote.gasFeeNative.toFixed(),
        gasFeeUsd: quote.gasFeeUsd.toFixed(),
        route: (quote.route as never) ?? undefined,
        status: quote.rejectedReason ? 'REJECTED' : 'QUOTED',
        failureReason: quote.rejectedReason ?? null,
      },
    });
    ids.set(`${quote.venueKind}:${quote.venueName}`, id);
  }

  return ids;
}

/** Best usable venue: highest net output among those with no rejection. */
export function selectBestVenue(quotes: VenueQuoteResult[]): VenueQuoteResult | null {
  const usable = quotes.filter((q) => !q.rejectedReason && q.netOutput.isPositive());
  if (usable.length === 0) return null;

  return usable.reduce((best, candidate) =>
    candidate.netOutput.gt(best.netOutput) ? candidate : best,
  );
}

/**
 * Execute against the chosen venue.
 *
 * For DEX this is: simulate, refuse on predicted revert, then submit with the
 * on-chain floor and a deadline, through private infrastructure where available.
 */
export async function executeAtVenue(
  db: DbClient,
  params: {
    request: SourcingRequest;
    venue: VenueQuoteResult;
    attemptId: string;
  },
  context: AuditContext = {},
): Promise<SourcingResult> {
  const { request, venue, attemptId } = params;

  await audit(prisma, {
    ...context,
    actorType: 'SYSTEM',
    action: AuditAction.ROUTE_SELECTED,
    entityType: 'Order',
    entityId: request.orderId,
    after: {
      venueKind: venue.venueKind,
      venueName: venue.venueName,
      expectedOutput: venue.expectedOutput.toFixed(),
      netOutput: venue.netOutput.toFixed(),
      priceImpactBps: venue.priceImpactBps,
      minOutput: request.minOutput.toFixed(),
    },
  });

  if (venue.venueKind === 'INVENTORY') {
    await prisma.executionAttempt.update({
      where: { id: attemptId },
      data: {
        status: 'FILLED',
        actualOutput: venue.expectedOutput.toFixed(),
        completedAt: new Date(),
      },
    });
    return {
      venueKind: 'INVENTORY',
      venueName: 'treasury',
      output: venue.expectedOutput,
      input: request.amountIn,
      priceImpactBps: 0,
      gasFeeNative: new Decimal(0),
      protocolFee: new Decimal(0),
      fromInventory: true,
      attemptId,
    };
  }

  if (venue.venueKind === 'OTC') {
    return executeOtc(params, context);
  }

  return executeDex(db, params, context);
}

async function executeOtc(
  params: { request: SourcingRequest; venue: VenueQuoteResult; attemptId: string },
  context: AuditContext,
): Promise<SourcingResult> {
  const { request, venue, attemptId } = params;

  const placed = await liquidityProvider().placeOrder({
    idempotencyKey: `otc:${request.orderId}`,
    symbol: request.asset.symbol,
    quoteCurrency: 'USD',
    side: request.side,
    fiatAmount: request.side === 'BUY' ? request.amountIn.toFixed(USD_SCALE) : undefined,
    cryptoAmount: request.side === 'SELL' ? request.amountIn.toFixed() : undefined,
    maxSlippageBps: env().EXECUTION_SLIPPAGE_TOLERANCE_BPS,
  });

  const output =
    request.side === 'BUY'
      ? new Decimal(placed.data.filledCryptoAmount)
      : new Decimal(placed.data.filledFiatAmount);

  if (placed.data.status === 'REJECTED' || output.isZero()) {
    await prisma.executionAttempt.update({
      where: { id: attemptId },
      data: {
        status: 'FAILED',
        failureReason: placed.data.rejectReason ?? 'OTC did not fill',
        completedAt: new Date(),
      },
    });
    throw new ValidationError(placed.data.rejectReason ?? 'The OTC venue did not fill this order');
  }

  await prisma.executionAttempt.update({
    where: { id: attemptId },
    data: {
      status: 'FILLED',
      actualOutput: output.toFixed(),
      externalRef: placed.data.externalOrderId,
      completedAt: new Date(),
    },
  });

  return {
    venueKind: 'OTC',
    venueName: venue.venueName,
    output,
    input: request.amountIn,
    priceImpactBps: 0,
    gasFeeNative: new Decimal(0),
    protocolFee: new Decimal(placed.data.fee || '0'),
    externalRef: placed.data.externalOrderId,
    fromInventory: false,
    attemptId,
  };
}

async function executeDex(
  db: DbClient,
  params: { request: SourcingRequest; venue: VenueQuoteResult; attemptId: string },
  context: AuditContext,
): Promise<SourcingResult> {
  const { request, venue, attemptId } = params;
  const route = venue.route;
  if (!route) throw new ValidationError('DEX venue selected without a route');

  const chain = request.asset.chain!;
  const wallet = await hotWalletFor(db, chain);

  // The floor we will accept, enforced on-chain. Never wider than what the
  // customer was promised.
  const minAmountOut = request.minOutput;

  // 1. Simulate. A swap that would revert is never submitted, so we do not pay
  //    gas to discover it.
  const simulation = await dexProvider().simulate(route.routeId, minAmountOut.toFixed());
  await prisma.executionAttempt.update({
    where: { id: attemptId },
    data: { status: 'SIMULATING' },
  });

  if (simulation.data.outcome !== 'WOULD_SUCCEED') {
    await prisma.executionAttempt.update({
      where: { id: attemptId },
      data: {
        status: 'REJECTED',
        failureReason: `Simulation predicted failure: ${simulation.data.revertReason ?? simulation.data.outcome}`,
        completedAt: new Date(),
      },
    });
    await audit(prisma, {
      ...context,
      actorType: 'SYSTEM',
      action: AuditAction.ROUTE_REJECTED,
      entityType: 'Order',
      entityId: request.orderId,
      after: { reason: simulation.data.revertReason, venue: venue.venueName },
    });
    throw new ValidationError(
      'The market moved while we were pricing your order. Please try again.',
    );
  }

  // 2. Submit, with a floor and a deadline, privately where the chain allows it.
  const deadline = new Date(Date.now() + 60_000);
  const swapId = newId();

  const swap = await prisma.swapTransaction.create({
    data: {
      id: swapId,
      executionAttemptId: attemptId,
      treasuryWalletId: wallet.id,
      protocolId: venue.protocolId!,
      chain,
      fromSymbol: route.fromSymbol,
      toSymbol: route.toSymbol,
      amountIn: request.amountIn.toFixed(),
      minAmountOut: minAmountOut.toFixed(),
      privateSubmission: true,
      status: 'SIMULATED',
      simulation: simulation.data as never,
      idempotencyKey: `swap:${request.orderId}`,
      deadline,
    },
  });

  let receipt;
  try {
    receipt = await dexProvider().submit({
      idempotencyKey: swap.idempotencyKey,
      routeId: route.routeId,
      chain,
      fromSymbol: route.fromSymbol,
      toSymbol: route.toSymbol,
      amountIn: request.amountIn.toFixed(),
      minAmountOut: minAmountOut.toFixed(),
      fromAddress: wallet.address,
      deadline,
      private: true,
    });
  } catch (error) {
    await prisma.swapTransaction.update({
      where: { id: swapId },
      // A submission that errors may still have landed. UNKNOWN, not FAILED.
      data: { status: 'PENDING', failureReason: error instanceof Error ? error.message : String(error) },
    });
    await prisma.executionAttempt.update({
      where: { id: attemptId },
      data: { status: 'FAILED', failureReason: 'Submission failed', completedAt: new Date() },
    });
    throw error;
  }

  await prisma.swapTransaction.update({
    where: { id: swapId },
    data: {
      status: receipt.data.status === 'REVERTED' ? 'REVERTED' : 'SUBMITTED',
      txHash: receipt.data.txHash ?? null,
      privateSubmission: receipt.data.privateSubmission,
      submittedAt: new Date(),
      failureReason: receipt.data.failureReason ?? null,
    },
  });

  if (receipt.data.status === 'REVERTED') {
    await prisma.executionAttempt.update({
      where: { id: attemptId },
      data: {
        status: 'FAILED',
        failureReason: receipt.data.failureReason ?? 'Swap reverted',
        completedAt: new Date(),
      },
    });
    await audit(prisma, {
      ...context,
      actorType: 'SYSTEM',
      action: AuditAction.SWAP_REVERTED,
      entityType: 'Order',
      entityId: request.orderId,
      after: { txHash: receipt.data.txHash, reason: receipt.data.failureReason },
    });
    // The floor did its job: we kept our input and lost only gas.
    throw new ValidationError(
      'The market moved beyond your quoted price, so the trade was not executed.',
    );
  }

  await audit(prisma, {
    ...context,
    actorType: 'SYSTEM',
    action: AuditAction.SWAP_SUBMITTED,
    entityType: 'Order',
    entityId: request.orderId,
    after: {
      txHash: receipt.data.txHash,
      privateSubmission: receipt.data.privateSubmission,
      minAmountOut: minAmountOut.toFixed(),
    },
  });

  // 3. Confirm.
  const confirmed = await dexProvider().getSwapStatus(receipt.data.externalId);
  const output = new Decimal(confirmed.data.amountOut ?? receipt.data.amountOut ?? '0');
  const gasFee = new Decimal(confirmed.data.gasFeeNative ?? route.estimatedGasNative);

  if (confirmed.data.status !== 'CONFIRMED' || output.isZero()) {
    await prisma.swapTransaction.update({
      where: { id: swapId },
      data: { status: 'FAILED', failureReason: confirmed.data.failureReason ?? 'Not confirmed' },
    });
    await prisma.executionAttempt.update({
      where: { id: attemptId },
      data: { status: 'FAILED', failureReason: 'Swap did not confirm', completedAt: new Date() },
    });
    throw new ValidationError('The on-chain trade did not confirm. Your funds are unchanged.');
  }

  // The floor is checked again against what actually arrived. Belt and braces:
  // the on-chain call should already have reverted, but we never settle a
  // customer on an unverified number.
  if (output.lt(minAmountOut)) {
    await prisma.executionAttempt.update({
      where: { id: attemptId },
      data: {
        status: 'FAILED',
        actualOutput: output.toFixed(),
        failureReason: 'Filled below the promised floor',
        completedAt: new Date(),
      },
    });
    throw new ValidationError('The trade filled below your quoted price and was rejected.');
  }

  await prisma.swapTransaction.update({
    where: { id: swapId },
    data: {
      status: 'CONFIRMED',
      amountOut: output.toFixed(),
      gasFeeNative: gasFee.toFixed(),
      blockNumber: confirmed.data.blockNumber ?? null,
      confirmedAt: new Date(),
    },
  });

  await prisma.executionAttempt.update({
    where: { id: attemptId },
    data: {
      status: 'FILLED',
      actualOutput: output.toFixed(),
      externalRef: confirmed.data.txHash ?? receipt.data.externalId,
      completedAt: new Date(),
    },
  });

  await audit(prisma, {
    ...context,
    actorType: 'SYSTEM',
    action: AuditAction.SWAP_CONFIRMED,
    entityType: 'Order',
    entityId: request.orderId,
    after: { txHash: confirmed.data.txHash, output: output.toFixed(), gasFee: gasFee.toFixed() },
  });

  const gasSymbol = await nativeSymbolForChain(db, chain);

  return {
    venueKind: 'DEX',
    venueName: venue.venueName,
    output,
    input: request.amountIn,
    priceImpactBps: venue.priceImpactBps,
    gasFeeNative: gasFee,
    gasAssetSymbol: gasSymbol,
    protocolFee: venue.protocolFee,
    protocolId: venue.protocolId,
    txHash: confirmed.data.txHash,
    externalRef: confirmed.data.txHash ?? receipt.data.externalId,
    fromInventory: false,
    attemptId,
  };
}

async function nativeSymbolForChain(db: DbClient, chain: string): Promise<string | undefined> {
  const native = await db.asset.findFirst({
    where: { chain, isNativeAsset: true, isActive: true },
    select: { symbol: true },
  });
  return native?.symbol;
}

/** Convenience guard used by the quote service before it prices anything. */
export function assertTradable(asset: Asset): void {
  if (!asset.isActive || !asset.tradingEnabled) {
    throw new ValidationError(`${asset.symbol} is not currently tradable`);
  }
  assertTierAllowsAutomaticExecution(asset);
}

export { ForbiddenError };

/**
 * Reference price, taken from a venue that will actually serve us.
 *
 * On-chain first, OTC second. That order matters: pricing off a counterparty
 * that refuses to trade with a Somali entity would produce quotes we cannot
 * honour. If no venue can price the asset we say so rather than inventing a rate.
 *
 * The returned rate already embeds the price impact of THIS size, so a large
 * order is quoted at the price it would really get.
 */
export async function getReferenceRate(
  db: DbClient,
  params: {
    asset: Asset;
    side: 'BUY' | 'SELL';
    /** BUY: USD to spend. SELL: crypto to sell. */
    amountIn: Decimal;
  },
): Promise<{ rate: Decimal; source: ExecutionVenueKind; quoteRef?: string }> {
  const chain = params.asset.chain;

  if (chain) {
    const allowed = await approvedSlugs(db, chain);
    if (allowed.length > 0) {
      const stable = await db.asset.findUnique({ where: { symbol: STABLE_SYMBOL } });
      if (stable) {
        try {
          const routes = await dexProvider().getRoutes({
            chain,
            fromSymbol: params.side === 'BUY' ? stable.symbol : params.asset.symbol,
            toSymbol: params.side === 'BUY' ? params.asset.symbol : stable.symbol,
            amountIn: params.amountIn.toFixed(),
            allowedProtocols: allowed,
          });

          const best = routes.data[0];
          if (best && new Decimal(best.expectedOut).isPositive()) {
            const out = new Decimal(best.expectedOut);
            // BUY: USD in / crypto out. SELL: USD out / crypto in.
            const rate =
              params.side === 'BUY'
                ? params.amountIn.dividedBy(out)
                : out.dividedBy(params.amountIn);
            return { rate: rate.toDecimalPlaces(18), source: 'DEX', quoteRef: best.routeId };
          }
        } catch {
          // Fall through to the OTC desk.
        }
      }
    }
  }

  try {
    const quote = await liquidityProvider().getQuote({
      symbol: params.asset.symbol,
      quoteCurrency: 'USD',
      side: params.side,
      fiatAmount: params.side === 'BUY' ? params.amountIn.toFixed(USD_SCALE) : undefined,
      cryptoAmount: params.side === 'SELL' ? params.amountIn.toFixed() : undefined,
    });
    const rate = new Decimal(quote.data.rate);
    if (rate.isPositive() && !rate.isZero()) {
      return { rate, source: 'OTC', quoteRef: quote.data.quoteRef };
    }
  } catch {
    // Neither venue could price it.
  }

  throw new ValidationError(
    `We cannot price ${params.asset.symbol} right now. Please try again shortly.`,
  );
}
