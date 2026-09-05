import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from '../../src/domain/money';
import {
  InsufficientFundsError,
  QuoteAlreadyUsedError,
  QuoteExpiredError,
  ValidationError,
} from '../../src/domain/errors';
import { mockScenarios } from '../../src/providers/mock-support';
import { resetProviders } from '../../src/providers/registry';
import { signMockWebhook } from '../../src/providers/payment/mock';
import { prisma as db } from '../../src/server/db';
import { AccountCode } from '../../src/services/accounts';
import { createDeposit, verifyAndCreditDeposit } from '../../src/services/deposit';
import { getAccountBalance, getUserBalances, postTransaction } from '../../src/services/ledger';
import * as journal from '../../src/services/journal';
import { inventoryPosition } from '../../src/services/treasury';
import { createOrder, executeOrder, fundPendingOrder } from '../../src/services/order';
import { createQuote } from '../../src/services/quote';
import { reconcile } from '../../src/services/reconcile';
import {
  confirmWithdrawal,
  pollWithdrawal,
  requestWithdrawal,
  submitWithdrawal,
} from '../../src/services/withdrawal';
import { ingestWebhook } from '../../src/services/webhook';
import { paymentProvider } from '../../src/providers/registry';
import { newId } from '../../src/domain/id';
import { approveKyc, createUser, fundTreasury, getAsset, resetDatabase } from '../helpers';

/** Deposit USD and get it credited, the way the real flow does. */
async function fundAccount(userId: string, amount: string): Promise<void> {
  const deposit = await createDeposit({
    userId,
    amount,
    payerAccountRef: '+252612345678',
    idempotencyKey: `fund:${newId()}`,
  });
  await verifyAndCreditDeposit(deposit.id);
}

async function usdBalance(userId: string): Promise<Decimal> {
  const usd = await getAsset('USD');
  const balance = await getAccountBalance(db, {
    code: AccountCode.USER_FIAT,
    assetId: usd.id,
    userId,
  });
  return balance.natural;
}

async function cryptoBalance(userId: string, symbol: string): Promise<Decimal> {
  const asset = await getAsset(symbol);
  const balance = await getAccountBalance(db, {
    code: AccountCode.USER_CRYPTO,
    assetId: asset.id,
    userId,
  });
  return balance.natural;
}

/**
 * Remove all free inventory of an asset, so the router has to look elsewhere.
 * Used to reach the fallback paths deliberately.
 */
async function drainTreasury(symbol: string): Promise<void> {
  const asset = await getAsset(symbol);
  const position = await inventoryPosition(db, asset.id);
  if (!position.free.isPositive()) return;

  const template = journal.treasuryDefunding({
    assetId: asset.id,
    amount: position.free,
  });
  await postTransaction(db, {
    type: template.type,
    referenceType: 'Treasury',
    referenceId: `drain:${symbol}`,
    idempotencyKey: `drain:${symbol}:${position.free.toFixed()}`,
    description: 'Test: remove free inventory so the router must look elsewhere',
    occurredAt: new Date(),
    legs: template.legs,
  });
}

/** After every flow the books must be internally consistent and solvent. */
async function expectBooksHealthy(): Promise<void> {
  const report = await reconcile({ staleMinutes: 10_000 });
  expect(report.drift).toEqual([]);
  for (const total of report.ledgerTotals) {
    // Compare numerically: Postgres returns NUMERIC(38,18) as "0.000000000000000000".
    expect(`${total.assetSymbol}:${new Decimal(total.total).isZero()}`).toBe(
      `${total.assetSymbol}:true`,
    );
  }
  for (const s of report.solvency) {
    // Name the asset and the number, so a failure says which book is short.
    expect(
      `${s.assetSymbol} surplus ${new Decimal(s.surplus).isNegative() ? s.surplus : 'ok'}`,
    ).toBe(`${s.assetSymbol} surplus ok`);
  }
}

describe('money flows', () => {
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    // Customers trade against inventory, so the book must be funded first.
    await fundTreasury();
    resetProviders();
    mockScenarios.clear();
    const user = await createUser();
    userId = user.id;
    await approveKyc(userId);
  });

  afterEach(() => {
    mockScenarios.clear();
  });

  // -------------------------------------------------------------------------
  describe('deposits', () => {
    it('credits a verified deposit exactly once', async () => {
      const deposit = await createDeposit({
        userId,
        amount: '100',
        payerAccountRef: '+252612345678',
        idempotencyKey: 'dep-key-1',
      });
      expect(deposit.status).toBe('AWAITING_PAYMENT');

      const credited = await verifyAndCreditDeposit(deposit.id);
      expect(credited.status).toBe('CREDITED');

      // Mock provider charges 1%; the customer bears it.
      expect((await usdBalance(userId)).toFixed(2)).toBe('99.00');
      await expectBooksHealthy();
    });

    it('does not double-credit when verification is called repeatedly', async () => {
      const deposit = await createDeposit({
        userId,
        amount: '100',
        payerAccountRef: '+252612345678',
        idempotencyKey: 'dep-key-2',
      });

      await verifyAndCreditDeposit(deposit.id);
      await verifyAndCreditDeposit(deposit.id);
      await verifyAndCreditDeposit(deposit.id);

      expect((await usdBalance(userId)).toFixed(2)).toBe('99.00');
      expect(await db.ledgerTransaction.count({ where: { type: 'USD_DEPOSIT' } })).toBe(1);
      await expectBooksHealthy();
    });

    it('creates only one payment request for a duplicated idempotency key', async () => {
      const first = await createDeposit({
        userId,
        amount: '50',
        payerAccountRef: '+252612345678',
        idempotencyKey: 'dep-key-3',
      });
      const second = await createDeposit({
        userId,
        amount: '50',
        payerAccountRef: '+252612345678',
        idempotencyKey: 'dep-key-3',
      });

      expect(second.id).toBe(first.id);
      expect(await db.deposit.count()).toBe(1);
    });

    it('does not credit a payment the provider reports as failed', async () => {
      const deposit = await createDeposit({
        userId,
        amount: '100',
        payerAccountRef: '+252612345678',
        idempotencyKey: 'dep-key-4',
      });

      mockScenarios.set('mock', 'PAYMENT_FAILED');
      const result = await verifyAndCreditDeposit(deposit.id);

      expect(result.status).toBe('FAILED');
      expect((await usdBalance(userId)).toFixed(2)).toBe('0.00');
      await expectBooksHealthy();
    });

    it('leaves an unpaid deposit uncredited', async () => {
      const deposit = await createDeposit({
        userId,
        amount: '100',
        payerAccountRef: '+252612345678',
        idempotencyKey: 'dep-key-5',
      });

      mockScenarios.set('mock', 'PAYMENT_PENDING');
      const result = await verifyAndCreditDeposit(deposit.id);

      expect(result.status).toBe('AWAITING_PAYMENT');
      expect((await usdBalance(userId)).toFixed(2)).toBe('0.00');
    });
  });

  // -------------------------------------------------------------------------
  describe('webhooks', () => {
    async function fireWebhook(body: Record<string, unknown>, signature?: string) {
      const rawBody = JSON.stringify(body);
      return ingestWebhook({
        provider: 'mock',
        request: {
          rawBody,
          headers: { 'x-mock-signature': signature ?? signMockWebhook(rawBody) },
        },
        parse: (request) => paymentProvider().handleWebhook(request),
        handle: async () => {
          /* handled by the deposit route in production */
        },
      });
    }

    it('processes a correctly signed webhook', async () => {
      const outcome = await fireWebhook({
        eventId: 'evt-1',
        event: 'deposit.succeeded',
        paymentId: 'pay_x',
        amount: '100',
        currency: 'USD',
      });
      expect(outcome.status).toBe('PROCESSED');
    });

    it('treats a replayed webhook as a duplicate and does not re-handle it', async () => {
      const body = {
        eventId: 'evt-2',
        event: 'deposit.succeeded',
        paymentId: 'pay_y',
        amount: '100',
        currency: 'USD',
      };

      const first = await fireWebhook(body);
      const second = await fireWebhook(body);
      const third = await fireWebhook(body);

      expect(first.status).toBe('PROCESSED');
      expect(second.status).toBe('DUPLICATE');
      expect(third.status).toBe('DUPLICATE');
      expect(await db.webhookEvent.count({ where: { status: 'PROCESSED' } })).toBe(1);
    });

    it('rejects a webhook whose signature does not match the body', async () => {
      const outcome = await fireWebhook(
        { eventId: 'evt-3', event: 'deposit.succeeded', paymentId: 'pay_z' },
        'not-a-real-signature',
      );
      expect(outcome.status).toBe('REJECTED');
      expect(await db.webhookEvent.count({ where: { status: 'REJECTED' } })).toBe(1);
    });

    it('rejects a tampered body that reuses a valid signature', async () => {
      const original = JSON.stringify({ eventId: 'evt-4', amount: '1' });
      const validSignature = signMockWebhook(original);

      const outcome = await ingestWebhook({
        provider: 'mock',
        request: {
          // Same signature, different body — the classic tamper.
          rawBody: JSON.stringify({ eventId: 'evt-4', amount: '1000000' }),
          headers: { 'x-mock-signature': validSignature },
        },
        parse: (request) => paymentProvider().handleWebhook(request),
        handle: async () => {},
      });

      expect(outcome.status).toBe('REJECTED');
    });

    it('rejects a signed webhook with no event id, since it cannot be deduplicated', async () => {
      const outcome = await fireWebhook({ event: 'deposit.succeeded', paymentId: 'pay_q' });
      expect(outcome.status).toBe('REJECTED');
    });
  });

  // -------------------------------------------------------------------------
  describe('quotes', () => {
    it('prices a buy with the fee taken from the customer amount', async () => {
      const { breakdown } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '100',
      });

      expect(breakdown.fiatAmount).toBe('100');
      expect(new Decimal(breakdown.brokerageFee).toFixed(2)).toBe('1.00');
      expect(new Decimal(breakdown.cryptoAmount).isPositive()).toBe(true);
      expect(breakdown.expiresInSeconds).toBeGreaterThan(0);
    });

    it('refuses an expired quote', async () => {
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '100',
      });

      await db.quote.update({
        where: { id: quote.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        createOrder({ userId, quoteId: quote.id, idempotencyKey: 'ord-expired' }),
      ).rejects.toThrow(QuoteExpiredError);
    });

    it('refuses to reuse a consumed quote', async () => {
      await fundAccount(userId, '300');
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '100',
      });

      await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'ord-a' });
      await expect(
        createOrder({ userId, quoteId: quote.id, idempotencyKey: 'ord-b' }),
      ).rejects.toThrow(QuoteAlreadyUsedError);
    });

    it('will not let one customer spend another customer quote', async () => {
      const other = await createUser();
      await approveKyc(other.id);

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '100',
      });

      await expect(
        createOrder({ userId: other.id, quoteId: quote.id, idempotencyKey: 'ord-theft' }),
      ).rejects.toThrow(/not found/i);
    });

    it('enforces the per-asset minimum order size', async () => {
      await expect(
        createQuote(db, { userId, assetSymbol: 'BTC', side: 'BUY', fiatAmount: '1' }),
      ).rejects.toThrow(ValidationError);
    });

    it('refuses to quote for an unverified customer', async () => {
      const unverified = await createUser();
      await expect(
        createQuote(db, {
          userId: unverified.id,
          assetSymbol: 'BTC',
          side: 'BUY',
          fiatAmount: '100',
        }),
      ).rejects.toThrow(/verification/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('buy', () => {
    it('executes the full buy flow and credits crypto', async () => {
      await fundAccount(userId, '200');
      const before = await usdBalance(userId);

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'buy-1' });
      expect(order.status).toBe('PAID');

      const settled = await executeOrder(order.id);
      expect(settled.status).toBe('SETTLED');
      expect(new Decimal(settled.filledCryptoAmount.toString()).isPositive()).toBe(true);
      expect(settled.executionPrice).not.toBeNull();
      // Sourced from stock: no venue was touched, so there is no external id.
      expect(settled.executionVenue).toBe('INVENTORY');
      expect(settled.providerOrderId).toBeNull();

      // The customer paid exactly the quoted USD and holds BTC.
      const after = await usdBalance(userId);
      expect(before.minus(after).toFixed(2)).toBe('100.00');
      expect((await cryptoBalance(userId, 'BTC')).isPositive()).toBe(true);

      // Fees were actually recognised, and trades recorded.
      const trades = await db.trade.findMany({ where: { orderId: order.id } });
      expect(trades.length).toBeGreaterThan(0);

      await expectBooksHealthy();
    });

    it('leaves an underfunded buy awaiting payment, then funds it', async () => {
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'buy-2' });
      expect(order.status).toBe('PENDING_PAYMENT');

      await fundAccount(userId, '150');
      const funded = await fundPendingOrder(order.id);
      expect(funded.status).toBe('PAID');

      const settled = await executeOrder(order.id);
      expect(settled.status).toBe('SETTLED');
      await expectBooksHealthy();
    });

    it('falls back to an external venue when inventory is short', async () => {
      // Drain the book so inventory cannot serve this order.
      await drainTreasury('BTC');
      await fundAccount(userId, '400');

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'buy-fb' });
      const settled = await executeOrder(order.id);

      expect(settled.status).toBe('SETTLED');
      expect(settled.executionVenue).not.toBe('INVENTORY');

      // Every venue considered is on the record, including the rejected ones.
      const attempts = await db.executionAttempt.findMany({ where: { orderId: order.id } });
      expect(attempts.length).toBeGreaterThan(1);
      expect(attempts.some((a) => a.venueKind === 'INVENTORY' && a.status === 'REJECTED')).toBe(
        true,
      );

      await expectBooksHealthy();
    });

    it('refunds in full when inventory is short and every venue refuses', async () => {
      await drainTreasury('BTC');
      await fundAccount(userId, '400');
      const before = await usdBalance(userId);

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'buy-4' });

      // Nothing left to fall back to: OTC rejects, and BTC has no approved
      // on-chain protocol in the seed.
      mockScenarios.set('mock', 'ORDER_REJECTED');
      await expect(executeOrder(order.id)).rejects.toThrow();

      const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.status).toBe('REFUNDED');
      expect((await usdBalance(userId)).toFixed(2)).toBe(before.toFixed(2));

      // Nothing stranded in the hold.
      const usd = await getAsset('USD');
      const hold = await getAccountBalance(db, {
        code: AccountCode.ORDER_HOLD,
        assetId: usd.id,
        userId,
      });
      expect(hold.natural.toFixed(2)).toBe('0.00');

      await expectBooksHealthy();
    });

    it('refunds when the venue call fails outright', async () => {
      await drainTreasury('BTC');
      await fundAccount(userId, '400');
      const before = await usdBalance(userId);

      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'buy-5' });

      mockScenarios.set('mock', 'PROVIDER_TIMEOUT');
      await expect(executeOrder(order.id)).rejects.toThrow();

      const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.status).toBe('REFUNDED');
      expect((await usdBalance(userId)).toFixed(2)).toBe(before.toFixed(2));
      await expectBooksHealthy();
    });

    it('returns the same order for a duplicated idempotency key', async () => {
      await fundAccount(userId, '300');
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '100',
      });

      const first = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'buy-dup' });
      const second = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'buy-dup' });

      expect(second.id).toBe(first.id);
      expect(await db.order.count()).toBe(1);
    });

    it('executes only once when execution is retried', async () => {
      await fundAccount(userId, '200');
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '100',
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'buy-6' });

      await executeOrder(order.id);
      await executeOrder(order.id);
      await executeOrder(order.id);

      expect(
        await db.ledgerTransaction.count({ where: { type: 'CRYPTO_PURCHASE' } }),
      ).toBe(1);
      await expectBooksHealthy();
    });
  });

  // -------------------------------------------------------------------------
  describe('sell', () => {
    async function buyBtc(fiat = '200'): Promise<void> {
      await fundAccount(userId, String(Number(fiat) * 2));
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: fiat,
      });
      const order = await createOrder({
        userId,
        quoteId: quote.id,
        idempotencyKey: `buy-for-sell-${newId()}`,
      });
      await executeOrder(order.id);
    }

    it('executes the full sell flow and credits USD', async () => {
      await buyBtc('200');
      const btcBefore = await cryptoBalance(userId, 'BTC');
      const usdBefore = await usdBalance(userId);

      const sellAmount = btcBefore.dividedBy(2).toDecimalPlaces(8, Decimal.ROUND_DOWN);
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'SELL',
        cryptoAmount: sellAmount.toFixed(),
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'sell-1' });
      const settled = await executeOrder(order.id);

      expect(settled.status).toBe('SETTLED');
      expect((await usdBalance(userId)).gt(usdBefore)).toBe(true);
      expect((await cryptoBalance(userId, 'BTC')).lt(btcBefore)).toBe(true);

      await expectBooksHealthy();
    });

    it('refuses a sell the customer cannot cover', async () => {
      // Sized inside the tier limits, so the failure is genuinely about the
      // balance rather than about the order cap.
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'SELL',
        cryptoAmount: '0.005',
      });
      await expect(
        createOrder({ userId, quoteId: quote.id, idempotencyKey: 'sell-broke' }),
      ).rejects.toThrow(InsufficientFundsError);
    });

    it('absorbs a sale into inventory and increases free stock', async () => {
      await buyBtc('200');
      const btc = await getAsset('BTC');
      const before = await inventoryPosition(db, btc.id);
      const btcBefore = await cryptoBalance(userId, 'BTC');

      const sellAmount = btcBefore.dividedBy(2).toDecimalPlaces(8, Decimal.ROUND_DOWN);
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'SELL',
        cryptoAmount: sellAmount.toFixed(),
      });
      const order = await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'sell-2' });
      const settled = await executeOrder(order.id);

      expect(settled.status).toBe('SETTLED');

      // We owe the customer less crypto than before, so free inventory rose by
      // exactly what they sold — the coins never moved on-chain.
      const after = await inventoryPosition(db, btc.id);
      expect(after.free.minus(before.free).toFixed(8)).toBe(sellAmount.toFixed(8));
      expect(after.total.toFixed()).toBe(before.total.toFixed());

      await expectBooksHealthy();
    });
  });

  // -------------------------------------------------------------------------
  describe('withdrawals', () => {
    async function setupBtc(): Promise<{ walletId: string }> {
      await fundAccount(userId, '600');
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '250',
      });
      const order = await createOrder({
        userId,
        quoteId: quote.id,
        idempotencyKey: `buy-for-wd-${newId()}`,
      });
      await executeOrder(order.id);

      const btc = await getAsset('BTC');
      const wallet = await db.wallet.create({
        data: {
          id: newId(),
          userId,
          assetId: btc.id,
          network: 'bitcoin',
          address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
          label: 'My wallet',
        },
      });
      return { walletId: wallet.id };
    }

    it('completes a confirmed withdrawal end to end', async () => {
      const { walletId } = await setupBtc();
      const before = await cryptoBalance(userId, 'BTC');

      const { withdrawal, confirmationCode } = await requestWithdrawal({
        userId,
        assetSymbol: 'BTC',
        amount: '0.001',
        walletId,
        idempotencyKey: 'wd-1',
      });
      expect(withdrawal.status).toBe('AWAITING_CONFIRMATION');

      // Funds are NOT held until the customer confirms.
      expect((await cryptoBalance(userId, 'BTC')).toFixed()).toBe(before.toFixed());

      const confirmed = await confirmWithdrawal({
        withdrawalId: withdrawal.id,
        userId,
        code: confirmationCode!,
      });
      expect(confirmed.status).toBe('CONFIRMED');

      // Now they are held, and out of the spendable balance.
      expect((await cryptoBalance(userId, 'BTC')).toFixed()).toBe(
        before.minus('0.001').toFixed(),
      );

      await submitWithdrawal(withdrawal.id);

      // The mock advances two confirmations per poll; bitcoin needs two.
      let current = await pollWithdrawal(withdrawal.id);
      while (current.status !== 'COMPLETED' && current.status !== 'FAILED') {
        current = await pollWithdrawal(withdrawal.id);
      }

      expect(current.status).toBe('COMPLETED');
      expect(current.txHash).toBeTruthy();
      await expectBooksHealthy();
    });

    it('refuses an incorrect confirmation code and holds nothing', async () => {
      const { walletId } = await setupBtc();
      const before = await cryptoBalance(userId, 'BTC');

      const { withdrawal } = await requestWithdrawal({
        userId,
        assetSymbol: 'BTC',
        amount: '0.001',
        walletId,
        idempotencyKey: 'wd-2',
      });

      await expect(
        confirmWithdrawal({ withdrawalId: withdrawal.id, userId, code: '000000' }),
      ).rejects.toThrow(/not correct/i);

      expect((await cryptoBalance(userId, 'BTC')).toFixed()).toBe(before.toFixed());
    });

    it('refuses an expired confirmation code', async () => {
      const { walletId } = await setupBtc();
      const { withdrawal, confirmationCode } = await requestWithdrawal({
        userId,
        assetSymbol: 'BTC',
        amount: '0.001',
        walletId,
        idempotencyKey: 'wd-3',
      });

      await db.withdrawalConfirmation.updateMany({
        where: { withdrawalId: withdrawal.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        confirmWithdrawal({ withdrawalId: withdrawal.id, userId, code: confirmationCode! }),
      ).rejects.toThrow(/expired/i);
    });

    it('will not let another customer confirm a withdrawal', async () => {
      const { walletId } = await setupBtc();
      const attacker = await createUser();

      const { withdrawal, confirmationCode } = await requestWithdrawal({
        userId,
        assetSymbol: 'BTC',
        amount: '0.001',
        walletId,
        idempotencyKey: 'wd-4',
      });

      await expect(
        confirmWithdrawal({
          withdrawalId: withdrawal.id,
          userId: attacker.id,
          code: confirmationCode!,
        }),
      ).rejects.toThrow(/not found/i);
    });

    it('prevents spending the same coins twice via concurrent withdrawals', async () => {
      const { walletId } = await setupBtc();
      const balance = await cryptoBalance(userId, 'BTC');

      // Two withdrawals, each for the full balance.
      const amount = balance.toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed();
      const [a, b] = await Promise.all([
        requestWithdrawal({
          userId,
          assetSymbol: 'BTC',
          amount,
          walletId,
          idempotencyKey: 'wd-race-a',
        }),
        requestWithdrawal({
          userId,
          assetSymbol: 'BTC',
          amount,
          walletId,
          idempotencyKey: 'wd-race-b',
        }),
      ]);

      const results = await Promise.allSettled([
        confirmWithdrawal({
          withdrawalId: a.withdrawal.id,
          userId,
          code: a.confirmationCode!,
        }),
        confirmWithdrawal({
          withdrawalId: b.withdrawal.id,
          userId,
          code: b.confirmationCode!,
        }),
      ]);

      // Exactly one may succeed. The other must be rejected.
      const succeeded = results.filter((r) => r.status === 'fulfilled');
      expect(succeeded).toHaveLength(1);

      // And the balance can never go negative.
      expect((await cryptoBalance(userId, 'BTC')).isNegative()).toBe(false);
      await expectBooksHealthy();
    });

    it('releases the hold when the provider rejects the withdrawal', async () => {
      const { walletId } = await setupBtc();
      const before = await cryptoBalance(userId, 'BTC');

      const { withdrawal, confirmationCode } = await requestWithdrawal({
        userId,
        assetSymbol: 'BTC',
        amount: '0.001',
        walletId,
        idempotencyKey: 'wd-5',
      });
      await confirmWithdrawal({
        withdrawalId: withdrawal.id,
        userId,
        code: confirmationCode!,
      });

      mockScenarios.set('mock', 'WITHDRAWAL_FAILED');
      const failed = await submitWithdrawal(withdrawal.id);

      expect(failed.status).toBe('FAILED');
      // Money is back where it started, not stranded in the hold.
      expect((await cryptoBalance(userId, 'BTC')).toFixed()).toBe(before.toFixed());
      await expectBooksHealthy();
    });

    it('rejects a withdrawal to another customer wallet', async () => {
      await setupBtc();
      const other = await createUser();
      const btc = await getAsset('BTC');
      const foreignWallet = await db.wallet.create({
        data: {
          id: newId(),
          userId: other.id,
          assetId: btc.id,
          network: 'bitcoin',
          address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        },
      });

      await expect(
        requestWithdrawal({
          userId,
          assetSymbol: 'BTC',
          amount: '0.001',
          walletId: foreignWallet.id,
          idempotencyKey: 'wd-foreign',
        }),
      ).rejects.toThrow(/not found/i);
    });

    it('rejects a malformed destination address', async () => {
      await setupBtc();
      const btc = await getAsset('BTC');
      const badWallet = await db.wallet.create({
        data: {
          id: newId(),
          userId,
          assetId: btc.id,
          network: 'bitcoin',
          // An Ethereum address on the Bitcoin network.
          address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        },
      });

      await expect(
        requestWithdrawal({
          userId,
          assetSymbol: 'BTC',
          amount: '0.001',
          walletId: badWallet.id,
          idempotencyKey: 'wd-badaddr',
        }),
      ).rejects.toThrow(/not valid/i);
    });

    it('rejects a withdrawal below the asset minimum', async () => {
      const { walletId } = await setupBtc();
      await expect(
        requestWithdrawal({
          userId,
          assetSymbol: 'BTC',
          amount: '0.0000001',
          walletId,
          idempotencyKey: 'wd-tiny',
        }),
      ).rejects.toThrow(/minimum/i);
    });

    it('rejects a withdrawal larger than the balance', async () => {
      const { walletId } = await setupBtc();
      const balance = await cryptoBalance(userId, 'BTC');
      // Just over the balance, so the limit checks pass and the balance check
      // is what actually rejects it.
      const tooMuch = balance.times('1.5').toDecimalPlaces(8, Decimal.ROUND_UP);

      await expect(
        requestWithdrawal({
          userId,
          assetSymbol: 'BTC',
          amount: tooMuch.toFixed(),
          walletId,
          idempotencyKey: 'wd-huge',
        }),
      ).rejects.toThrow(/insufficient/i);
    });

    it('rejects a withdrawal that exceeds the daily limit', async () => {
      const { walletId } = await setupBtc();
      await expect(
        requestWithdrawal({
          userId,
          assetSymbol: 'BTC',
          amount: '10',
          walletId,
          idempotencyKey: 'wd-overlimit',
        }),
      ).rejects.toThrow(/24-hour limit/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('reconciliation', () => {
    it('reports healthy books after a full lifecycle', async () => {
      await fundAccount(userId, '500');

      const buyQuote = await createQuote(db, {
        userId,
        assetSymbol: 'ETH',
        side: 'BUY',
        fiatAmount: '200',
      });
      const buy = await createOrder({
        userId,
        quoteId: buyQuote.quote.id,
        idempotencyKey: 'lifecycle-buy',
      });
      await executeOrder(buy.id);

      const held = await cryptoBalance(userId, 'ETH');
      const sellQuote = await createQuote(db, {
        userId,
        assetSymbol: 'ETH',
        side: 'SELL',
        cryptoAmount: held.dividedBy(2).toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed(),
      });
      const sell = await createOrder({
        userId,
        quoteId: sellQuote.quote.id,
        idempotencyKey: 'lifecycle-sell',
      });
      await executeOrder(sell.id);

      const report = await reconcile({ staleMinutes: 10_000 });
      expect(report.healthy).toBe(true);
      expect(report.drift).toEqual([]);
    });

    it('detects projection drift when a balance is tampered with', async () => {
      await fundAccount(userId, '100');

      const usd = await getAsset('USD');
      const account = await db.ledgerAccount.findFirstOrThrow({
        where: { ownerUserId: userId, assetId: usd.id, code: AccountCode.USER_FIAT },
      });
      await db.$executeRawUnsafe(
        `UPDATE "balance_projections" SET "balance" = "balance" - 50 WHERE "accountId" = '${account.id}'`,
      );

      const report = await reconcile({ staleMinutes: 10_000 });
      expect(report.healthy).toBe(false);
      expect(report.drift.length).toBeGreaterThan(0);

      // And the repair restores agreement, because entries are the truth.
      const { rebuildProjections } = await import('../../src/services/reconcile');
      await rebuildProjections();
      const after = await reconcile({ staleMinutes: 10_000 });
      expect(after.drift).toEqual([]);
    });

    it('flags a deposit confirmed but never credited', async () => {
      const deposit = await createDeposit({
        userId,
        amount: '100',
        payerAccountRef: '+252612345678',
        idempotencyKey: 'stuck-dep',
      });
      await db.deposit.update({
        where: { id: deposit.id },
        data: { status: 'CONFIRMED', createdAt: new Date(Date.now() - 60 * 60_000) },
      });

      const report = await reconcile({ staleMinutes: 15 });
      const flagged = report.stuck.find((s) => s.id === deposit.id);
      expect(flagged).toBeDefined();
      expect(flagged?.kind).toBe('DEPOSIT');
    });
  });

  // -------------------------------------------------------------------------
  describe('balances', () => {
    it('never lets a customer see funds committed elsewhere', async () => {
      await fundAccount(userId, '300');
      const { quote } = await createQuote(db, {
        userId,
        assetSymbol: 'BTC',
        side: 'BUY',
        fiatAmount: '100',
      });
      await createOrder({ userId, quoteId: quote.id, idempotencyKey: 'hold-visible' });

      const balances = await getUserBalances(db, userId);
      const usd = balances.find((b) => b.symbol === 'USD')!;

      expect(usd.held.toFixed(2)).toBe('100.00');
      expect(usd.available.plus(usd.held).toFixed(2)).toBe(usd.total.toFixed(2));
    });
  });
});
