import { beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from '../../src/domain/money';
import { newId } from '../../src/domain/id';
import { mockScenarios } from '../../src/providers/mock-support';
import { resetProviders, screeningProvider } from '../../src/providers/registry';
import type { MockScreeningProvider } from '../../src/providers/screening/mock';
import { prisma as db } from '../../src/server/db';
import { createDeposit, verifyAndCreditDeposit } from '../../src/services/deposit';
import { createOrder, executeOrder } from '../../src/services/order';
import { createQuote } from '../../src/services/quote';
import { reconcile } from '../../src/services/reconcile';
import { screenAddress } from '../../src/services/screening';
import { requireApprovedProtocol } from '../../src/services/protocols';
import { checkOutbound, inventoryPosition, rebalanceSuggestions } from '../../src/services/treasury';
import * as journal from '../../src/services/journal';
import { postTransaction } from '../../src/services/ledger';
import { approveKyc, createUser, fundTreasury, getAsset, resetDatabase } from '../helpers';

/**
 * On-chain execution: routing, the risk controls that make it survivable, and
 * the accounting that keeps the book straight when a venue is involved.
 */

async function fund(userId: string, amount: string): Promise<void> {
  const deposit = await createDeposit({
    userId,
    amount,
    payerAccountRef: '+252612345678',
    idempotencyKey: `f:${newId()}`,
  });
  await verifyAndCreditDeposit(deposit.id);
}

/**
 * Force on-chain sourcing: no stock, and no OTC counterparty willing to quote.
 * That combination is the realistic default for a Somali brokerage, which is
 * why on-chain execution exists at all.
 */
async function forceOnChain(symbol: string): Promise<void> {
  // Leave a gas reserve: on Solana the traded asset is also the gas token, so
  // draining it completely would (correctly) make every on-chain route unusable.
  await drain(symbol, '0.5');
  mockScenarios.add('mock', 'OTC_UNAVAILABLE');
}

/** Remove free inventory (optionally keeping a reserve) so the router must source externally. */
async function drain(symbol: string, keep = '0'): Promise<void> {
  const asset = await getAsset(symbol);
  const position = await inventoryPosition(db, asset.id);
  const remove = position.free.minus(new Decimal(keep));
  if (remove.lte(0)) return;

  const template = journal.treasuryDefunding({ assetId: asset.id, amount: remove });
  await postTransaction(db, {
    type: template.type,
    referenceType: 'Treasury',
    referenceId: `drain:${symbol}`,
    idempotencyKey: `drain:${symbol}:${newId()}`,
    description: 'Test drain',
    occurredAt: new Date(),
    legs: template.legs,
  });
}

async function expectHealthy(): Promise<void> {
  const report = await reconcile({ staleMinutes: 10_000 });
  expect(report.drift).toEqual([]);
  for (const s of report.solvency) {
    expect(
      `${s.assetSymbol} ${new Decimal(s.surplus).isNegative() ? s.surplus : 'ok'}`,
    ).toBe(`${s.assetSymbol} ok`);
  }
}

describe('on-chain execution', () => {
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    await fundTreasury();
    resetProviders();
    mockScenarios.clear();
    const user = await createUser();
    userId = user.id;
    await approveKyc(userId);
  });

  // -------------------------------------------------------------------------
  describe('routing', () => {
    it('prefers inventory, and records every venue it considered', async () => {
      await fund(userId, '400');

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'SOL',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'r-1' });
      const settled = await executeOrder(order.id);

      expect(settled.executionVenue).toBe('INVENTORY');

      const attempts = await db.executionAttempt.findMany({
        where: { orderId: order.id },
        orderBy: { sequence: 'asc' },
      });
      // Inventory, at least one DEX route, and OTC — the full consideration set.
      expect(attempts.length).toBeGreaterThanOrEqual(3);
      expect(attempts.some((a) => a.venueKind === 'DEX')).toBe(true);
      expect(attempts.some((a) => a.venueKind === 'OTC')).toBe(true);

      // Every attempt records the floor it was measured against.
      for (const attempt of attempts) {
        expect(new Decimal(attempt.minOutput!.toString()).isPositive()).toBe(true);
      }
    });

    it('sources on-chain when inventory is short, and posts the swap separately', async () => {
      await forceOnChain('SOL');
      await fund(userId, '400');

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'SOL',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'r-2' });
      const settled = await executeOrder(order.id);

      expect(settled.status).toBe('SETTLED');
      expect(settled.executionVenue).toBe('DEX');

      // The swap is its own transaction, with a floor and a hash.
      const swap = await db.swapTransaction.findFirst({
        where: { idempotencyKey: `swap:${order.id}` },
      });
      expect(swap).not.toBeNull();
      expect(swap?.status).toBe('CONFIRMED');
      expect(swap?.txHash).toBeTruthy();
      expect(new Decimal(swap!.minAmountOut.toString()).isPositive()).toBe(true);
      expect(swap?.privateSubmission).toBe(true);

      // The customer's trade and our sourcing are separate journal entries.
      const entries = await db.ledgerTransaction.findMany({
        where: { referenceType: 'Order', referenceId: order.id },
      });
      const types = entries.map((e) => e.type);
      expect(types).toContain('CRYPTO_PURCHASE');
      expect(types).toContain('TREASURY_SWAP');

      await expectHealthy();
    });

    it('charges gas to the treasury and expenses it', async () => {
      await forceOnChain('SOL');
      await fund(userId, '400');

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'SOL',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'r-gas' });
      await executeOrder(order.id);

      const swapTx = await db.ledgerTransaction.findFirst({
        where: { referenceId: order.id, type: 'TREASURY_SWAP' },
        include: { entries: { include: { account: true } } },
      });
      expect(swapTx?.entries.some((e) => e.account.code === 'GAS_EXPENSE')).toBe(true);

      await expectHealthy();
    });

    it('executes only once when a routed order is retried', async () => {
      await forceOnChain('SOL');
      await fund(userId, '400');

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'SOL',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'r-3' });

      await executeOrder(order.id);
      await executeOrder(order.id);
      await executeOrder(order.id);

      expect(await db.swapTransaction.count()).toBe(1);
      expect(
        await db.ledgerTransaction.count({ where: { type: 'TREASURY_SWAP' } }),
      ).toBe(1);
      await expectHealthy();
    });
  });

  // -------------------------------------------------------------------------
  describe('slippage and MEV controls', () => {
    it('never submits without an on-chain minimum output', async () => {
      await forceOnChain('SOL');
      await fund(userId, '400');

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'SOL',
        side: 'BUY',
        fiatAmount: '100',
      });

      // The floor is fixed at quote time and carried through to the chain.
      expect(new Decimal(quote.minOutputAmount.toString()).isPositive()).toBe(true);
      expect(
        new Decimal(quote.minOutputAmount.toString()).lt(
          new Decimal(quote.cryptoAmount.toString()),
        ),
      ).toBe(true);

      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'r-4' });
      await executeOrder(order.id);

      const swap = await db.swapTransaction.findFirstOrThrow();
      expect(swap.minAmountOut.toString()).toBe(quote.minOutputAmount.toString());
    });

    it('refuses to execute when simulation predicts a revert, without spending gas', async () => {
      await forceOnChain('SOL');
      await fund(userId, '400');

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'SOL',
        side: 'BUY',
        fiatAmount: '100',
      });
      // Baseline before the hold is placed, so the refund is measured correctly.
      const before = await usdOf(userId);
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'r-5' });

      mockScenarios.add('mock', 'SWAP_WOULD_REVERT');
      await expect(executeOrder(order.id)).rejects.toThrow();

      // Nothing was submitted, so no swap row reached SUBMITTED.
      const swaps = await db.swapTransaction.findMany();
      expect(swaps.every((s) => s.status !== 'SUBMITTED' && s.status !== 'CONFIRMED')).toBe(true);

      const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.status).toBe('REFUNDED');
      expect((await usdOf(userId)).toFixed(2)).toBe(before.toFixed(2));
      await expectHealthy();
    });

    it('keeps the input when an adverse move pushes the fill below the floor', async () => {
      await forceOnChain('SOL');
      await fund(userId, '400');
      const before = await usdOf(userId);

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'SOL',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'r-6' });

      // A 3% adverse move against a floor set just below the quote.
      mockScenarios.add('mock', 'ADVERSE_PRICE_MOVE');
      await expect(executeOrder(order.id)).rejects.toThrow();

      const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.status).toBe('REFUNDED');
      expect((await usdOf(userId)).toFixed(2)).toBe(before.toFixed(2));
      await expectHealthy();
    });

    it('submits privately by default', async () => {
      await forceOnChain('SOL');
      await fund(userId, '400');

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'SOL',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'r-7' });
      await executeOrder(order.id);

      const swap = await db.swapTransaction.findFirstOrThrow();
      expect(swap.privateSubmission).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('liquidity tiers and price impact', () => {
    it('refuses to quote a tier-4 asset at all', async () => {
      const sol = await getAsset('SOL');
      await db.asset.update({ where: { id: sol.id }, data: { liquidityTier: 'TIER_4' } });

      await expect(
        createQuote(db, { userId, assetSymbol: 'SOL', side: 'BUY', fiatAmount: '100' }),
      ).rejects.toThrow(/not available/i);
    });

    it('routes a tier-3 asset to a manual quote rather than executing it', async () => {
      const sol = await getAsset('SOL');
      await db.asset.update({
        where: { id: sol.id },
        data: { liquidityTier: 'TIER_3', executionMode: 'RFQ' },
      });

      await expect(
        createQuote(db, { userId, assetSymbol: 'SOL', side: 'BUY', fiatAmount: '100' }),
      ).rejects.toThrow(/on request/i);
    });

    it('caps order size by asset, independently of the customer tier', async () => {
      const sol = await getAsset('SOL');
      await db.asset.update({
        where: { id: sol.id },
        data: { maxDexTradeUsd: '50', maxTradeUsd: '100000' },
      });

      await expect(
        createQuote(db, { userId, assetSymbol: 'SOL', side: 'BUY', fiatAmount: '100' }),
      ).rejects.toThrow(/largest .* order/i);
    });

    it('rejects a route whose price impact exceeds the asset cap', async () => {
      await forceOnChain('SOL');
      const sol = await getAsset('SOL');
      // Zero tolerance: every real route moves the price at least a little.
      await db.asset.update({ where: { id: sol.id }, data: { maxPriceImpactBps: 0 } });

      await expect(
        createQuote(db, { userId, assetSymbol: 'SOL', side: 'BUY', fiatAmount: '900' }),
      ).rejects.toThrow(/cannot source|smaller amount/i);
    });

    it('records the price impact the customer was shown', async () => {
      await forceOnChain('SOL');
      await fund(userId, '400');

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'SOL',
        side: 'BUY',
        fiatAmount: '100',
      });
      expect(quote.priceImpactBps).toBeGreaterThan(0);

      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'r-8' });
      const settled = await executeOrder(order.id);
      expect(settled.priceImpactBps).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('protocol whitelist', () => {
    it('refuses a protocol that is not in the registry', async () => {
      await expect(
        requireApprovedProtocol(db, { slug: 'definitely-not-registered', chain: 'ethereum' }),
      ).rejects.toThrow(/not in the registry/i);
    });

    it('refuses a registered but unapproved protocol', async () => {
      await expect(
        requireApprovedProtocol(db, { slug: 'mock-unapproved', chain: 'ethereum' }),
      ).rejects.toThrow(/not approved/i);
    });

    it('refuses a protocol registered on a different chain', async () => {
      await expect(
        requireApprovedProtocol(db, { slug: 'mock-agg-eth', chain: 'solana' }),
      ).rejects.toThrow(/registered on ethereum/i);
    });

    it('enforces the per-protocol trade ceiling', async () => {
      await expect(
        requireApprovedProtocol(db, {
          slug: 'mock-amm-eth',
          chain: 'ethereum',
          tradeUsd: new Decimal('999999'),
        }),
      ).rejects.toThrow(/ceiling/i);
    });

    it('will not route on a chain with no approved protocol', async () => {
      await db.protocol.updateMany({
        where: { chain: 'solana' },
        data: { isApproved: false },
      });
      await drain('SOL');
      await fund(userId, '400');

      // Inventory is gone and the chain has no approved venue, so only OTC is
      // left; the attempt record must say exactly why DEX was passed over.
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'SOL',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'r-9' });
      const settled = await executeOrder(order.id);

      expect(settled.executionVenue).toBe('OTC');
      const dexAttempt = await db.executionAttempt.findFirst({
        where: { orderId: order.id, venueKind: 'DEX' },
      });
      expect(dexAttempt?.failureReason).toMatch(/no approved protocol/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('treasury limits', () => {
    it('allows an outbound movement within the caps', async () => {
      const check = await checkOutbound(db, { chain: 'solana', valueUsd: new Decimal('100') });
      expect(check.allowed).toBe(true);
      expect(check.requiresApproval).toBe(false);
    });

    it('blocks a movement over the per-transaction cap', async () => {
      const check = await checkOutbound(db, { chain: 'solana', valueUsd: new Decimal('9000') });
      expect(check.allowed).toBe(false);
      expect(check.reason).toMatch(/per-transaction/i);
    });

    it('flags a large movement for human approval', async () => {
      const check = await checkOutbound(db, { chain: 'solana', valueUsd: new Decimal('3000') });
      expect(check.allowed).toBe(true);
      expect(check.requiresApproval).toBe(true);
    });

    it('permits nothing from a wallet with no configured limit', async () => {
      const check = await checkOutbound(db, {
        chain: 'ethereum',
        valueUsd: new Decimal('1'),
        tier: 'COLD',
      });
      expect(check.allowed).toBe(false);
      expect(check.reason).toMatch(/no outbound limit/i);
    });

    it('refuses a DEX route that would breach the wallet cap', async () => {
      await drain('SOL');
      const wallet = await db.treasuryWallet.findFirstOrThrow({
        where: { chain: 'solana', tier: 'HOT' },
      });
      await db.treasuryWallet.update({
        where: { id: wallet.id },
        data: { maxPerTxUsd: '10' },
      });

      mockScenarios.set('mock', 'OTC_UNAVAILABLE');
      const attempts = await routeAttemptsFor('SOL', '100');
      const dex = attempts.filter((a) => a.venueKind === 'DEX');
      expect(dex.length).toBeGreaterThan(0);
      expect(dex.every((a) => /limit/i.test(a.failureReason ?? ''))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('inventory', () => {
    it('reports free inventory as holdings less what customers are owed', async () => {
      const sol = await getAsset('SOL');
      const before = await inventoryPosition(db, sol.id);
      expect(before.free.toFixed()).toBe(before.total.toFixed());

      await fund(userId, '400');
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'SOL',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'inv-1' });
      await executeOrder(order.id);

      const after = await inventoryPosition(db, sol.id);
      // Total is unchanged — the coins never moved — but we now owe some of it.
      expect(after.total.toFixed()).toBe(before.total.toFixed());
      expect(after.owedToCustomers.isPositive()).toBe(true);
      expect(after.free.lt(before.free)).toBe(true);
      expect(after.free.plus(after.owedToCustomers).toFixed()).toBe(after.total.toFixed());
    });

    it('suggests a rebalance when free inventory leaves its band', async () => {
      await drain('SOL');
      const suggestions = await rebalanceSuggestions(db, async (symbol) =>
        symbol === 'SOL' ? new Decimal('145') : new Decimal('1'),
      );
      const sol = suggestions.find((s) => s.symbol === 'SOL');
      expect(sol?.action).toBe('BUY');
      expect(sol?.reason).toMatch(/below/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('blockchain screening', () => {
    it('accepts a clean address', async () => {
      const provider = screeningProvider() as MockScreeningProvider;
      provider.setRisk('0xclean', 'LOW');

      const outcome = await screenAddress({
        address: '0xclean',
        chain: 'ethereum',
        direction: 'INBOUND',
      });
      expect(outcome.decision).toBe('ACCEPT');
    });

    it('rejects sanctions exposure in both directions', async () => {
      mockScenarios.set('mock', 'SCREENING_SEVERE');

      for (const direction of ['INBOUND', 'OUTBOUND'] as const) {
        const outcome = await screenAddress({
          address: `0xsanctioned-${direction}`,
          chain: 'ethereum',
          direction,
        });
        expect(outcome.decision).toBe('REJECT');
      }
    });

    it('is stricter outbound than inbound for high risk', async () => {
      mockScenarios.set('mock', 'SCREENING_HIGH_RISK');

      const inbound = await screenAddress({
        address: '0xhigh-in',
        chain: 'ethereum',
        direction: 'INBOUND',
      });
      const outbound = await screenAddress({
        address: '0xhigh-out',
        chain: 'ethereum',
        direction: 'OUTBOUND',
      });

      // Receiving from a risky address is reviewable; sending to one is not.
      expect(inbound.decision).toBe('REVIEW');
      expect(outbound.decision).toBe('REJECT');
    });

    it('caches a verdict and reuses it', async () => {
      const provider = screeningProvider() as MockScreeningProvider;
      provider.setRisk('0xcached', 'LOW');

      const first = await screenAddress({
        address: '0xcached',
        chain: 'ethereum',
        direction: 'INBOUND',
      });
      const second = await screenAddress({
        address: '0xcached',
        chain: 'ethereum',
        direction: 'INBOUND',
      });

      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(await db.screeningResult.count({ where: { subject: '0xcached' } })).toBe(1);
    });

    it('does not reuse an expired verdict', async () => {
      const provider = screeningProvider() as MockScreeningProvider;
      provider.setRisk('0xstale', 'LOW');

      await screenAddress({ address: '0xstale', chain: 'ethereum', direction: 'INBOUND' });
      await db.screeningResult.updateMany({
        where: { subject: '0xstale' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const again = await screenAddress({
        address: '0xstale',
        chain: 'ethereum',
        direction: 'INBOUND',
      });
      expect(again.cached).toBe(false);
    });

    it('records a flagged address in the audit log', async () => {
      mockScenarios.set('mock', 'SCREENING_SEVERE');
      await screenAddress({ address: '0xbad', chain: 'ethereum', direction: 'OUTBOUND' });

      const entry = await db.auditLog.findFirst({ where: { action: 'screening.flagged' } });
      expect(entry).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------

async function usdOf(userId: string): Promise<Decimal> {
  const { getAccountBalance } = await import('../../src/services/ledger');
  const { AccountCode } = await import('../../src/services/accounts');
  const usd = await getAsset('USD');
  const balance = await getAccountBalance(db, {
    code: AccountCode.USER_FIAT,
    assetId: usd.id,
    userId,
  });
  return balance.natural;
}

/** Run the router far enough to inspect what it would have done. */
async function routeAttemptsFor(symbol: string, fiatAmount: string) {
  const { gatherVenueQuotes } = await import('../../src/services/execution');
  const asset = await getAsset(symbol);
  const usdAsset = await getAsset('USD');
  const amount = new Decimal(fiatAmount);

  const quotes = await gatherVenueQuotes(db, {
    orderId: 'probe',
    asset,
    usdAsset,
    side: 'BUY',
    amountIn: amount,
    expectedOutput: amount.dividedBy('145'),
    minOutput: amount.dividedBy('145').times('0.99'),
    notionalUsd: amount,
  });

  return quotes.map((q) => ({ venueKind: q.venueKind, failureReason: q.rejectedReason }));
}
