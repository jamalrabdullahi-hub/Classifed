import { beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from '../../src/domain/money';
import { ProviderNotConfiguredError } from '../../src/domain/errors';
import { MockBlockchainProvider } from '../../src/providers/blockchain/mock';
import { MockKYCProvider, signMockKycWebhook } from '../../src/providers/kyc/mock';
import { MockLiquidityProvider } from '../../src/providers/liquidity/mock';
import { MockPaymentProvider, signMockWebhook } from '../../src/providers/payment/mock';
import { WaafiPaymentProvider } from '../../src/providers/payment/waafi/index';
import { mockScenarios } from '../../src/providers/mock-support';

/**
 * Contract tests. Any real adapter must satisfy these too — they encode the
 * behaviour the services depend on, independent of vendor.
 */

describe('provider contracts', () => {
  beforeEach(() => {
    mockScenarios.clear();
  });

  describe('LiquidityProvider', () => {
    let venue: MockLiquidityProvider;

    beforeEach(() => {
      venue = new MockLiquidityProvider('test-seed');
    });

    it('quotes with amounts as decimal strings, never numbers', async () => {
      const quote = await venue.getQuote({
        symbol: 'BTC',
        quoteCurrency: 'USD',
        side: 'BUY',
        fiatAmount: '100',
      });
      expect(typeof quote.data.rate).toBe('string');
      expect(typeof quote.data.cryptoAmount).toBe('string');
      expect(new Decimal(quote.data.rate).isPositive()).toBe(true);
    });

    it('places one order for a repeated idempotency key', async () => {
      const input = {
        idempotencyKey: 'order-1',
        symbol: 'BTC' as const,
        quoteCurrency: 'USD',
        side: 'BUY' as const,
        fiatAmount: '100',
      };

      const first = await venue.placeOrder(input);
      const second = await venue.placeOrder(input);

      expect(second.data.externalOrderId).toBe(first.data.externalOrderId);
      expect(second.data.filledCryptoAmount).toBe(first.data.filledCryptoAmount);
    });

    it('reports the original order after a retry, via getOrderStatus', async () => {
      const placed = await venue.placeOrder({
        idempotencyKey: 'order-2',
        symbol: 'ETH',
        quoteCurrency: 'USD',
        side: 'BUY',
        fiatAmount: '50',
      });
      const status = await venue.getOrderStatus(placed.data.externalOrderId);
      expect(status.data.externalOrderId).toBe(placed.data.externalOrderId);
      expect(status.data.status).toBe('FILLED');
    });

    it('reports a partial fill with per-fill detail that sums to the total', async () => {
      mockScenarios.set('mock', 'PARTIAL_FILL');
      const order = await venue.placeOrder({
        idempotencyKey: 'order-3',
        symbol: 'BTC',
        quoteCurrency: 'USD',
        side: 'BUY',
        fiatAmount: '100',
      });

      expect(order.data.status).toBe('PARTIALLY_FILLED');
      expect(order.data.fills.length).toBeGreaterThan(1);

      const summed = order.data.fills.reduce(
        (acc, fill) => acc.plus(fill.quantity),
        new Decimal(0),
      );
      expect(summed.toFixed()).toBe(new Decimal(order.data.filledCryptoAmount).toFixed());
    });

    it('rejects an unsupported symbol rather than inventing a price', async () => {
      await expect(
        venue.getQuote({ symbol: 'DOGE', quoteCurrency: 'USD', side: 'BUY', fiatAmount: '10' }),
      ).rejects.toThrow(/does not support/);
    });

    it('refuses to cancel a filled order', async () => {
      const order = await venue.placeOrder({
        idempotencyKey: 'order-4',
        symbol: 'SOL',
        quoteCurrency: 'USD',
        side: 'BUY',
        fiatAmount: '20',
      });
      await expect(venue.cancelOrder(order.data.externalOrderId)).rejects.toThrow(/filled/);
    });
  });

  describe('PaymentProvider', () => {
    let payments: MockPaymentProvider;

    beforeEach(() => {
      payments = new MockPaymentProvider();
    });

    it('creates one payment request for a repeated idempotency key', async () => {
      const input = {
        idempotencyKey: 'pay-1',
        reference: 'ref-1',
        amount: '100',
        currency: 'USD',
        payerAccountRef: '+252612345678',
      };
      const first = await payments.createDeposit(input);
      const second = await payments.createDeposit(input);
      expect(second.data.externalId).toBe(first.data.externalId);
    });

    it('does not settle a deposit at creation time', async () => {
      const intent = await payments.createDeposit({
        idempotencyKey: 'pay-2',
        reference: 'ref-2',
        amount: '100',
        currency: 'USD',
        payerAccountRef: '+252612345678',
      });
      expect(intent.data.status).toBe('AWAITING_PAYMENT');
    });

    it('verifies a signed webhook and rejects a tampered one', async () => {
      const body = JSON.stringify({ eventId: 'e1', event: 'deposit.succeeded' });

      const good = await payments.handleWebhook({
        rawBody: body,
        headers: { 'x-mock-signature': signMockWebhook(body) },
      });
      expect(good.signatureValid).toBe(true);
      expect(good.externalEventId).toBe('e1');

      const bad = await payments.handleWebhook({
        rawBody: JSON.stringify({ eventId: 'e1', event: 'deposit.succeeded', extra: 1 }),
        headers: { 'x-mock-signature': signMockWebhook(body) },
      });
      expect(bad.signatureValid).toBe(false);
    });

    it('reports an unparseable webhook as invalid rather than throwing', async () => {
      const result = await payments.handleWebhook({
        rawBody: 'not json',
        headers: { 'x-mock-signature': signMockWebhook('not json') },
      });
      expect(result.signatureValid).toBe(false);
    });
  });

  describe('BlockchainProvider', () => {
    let chain: MockBlockchainProvider;

    beforeEach(() => {
      chain = new MockBlockchainProvider();
    });

    it('validates addresses per network', () => {
      expect(
        chain.validateAddress('BTC', 'bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'),
      ).toBe(true);
      expect(
        chain.validateAddress('ETH', 'ethereum', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'),
      ).toBe(true);

      // Right format, wrong chain.
      expect(
        chain.validateAddress('BTC', 'bitcoin', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'),
      ).toBe(false);
      expect(chain.validateAddress('BTC', 'bitcoin', '')).toBe(false);
      expect(chain.validateAddress('BTC', 'bitcoin', 'nonsense')).toBe(false);
    });

    it('creates one withdrawal for a repeated idempotency key', async () => {
      const input = {
        idempotencyKey: 'wd-1',
        symbol: 'BTC',
        network: 'bitcoin',
        address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
        amount: '0.01',
      };
      const first = await chain.createWithdrawal(input);
      const second = await chain.createWithdrawal(input);
      expect(second.data.externalId).toBe(first.data.externalId);
    });

    it('refuses a malformed address', async () => {
      await expect(
        chain.createWithdrawal({
          idempotencyKey: 'wd-2',
          symbol: 'BTC',
          network: 'bitcoin',
          address: 'definitely-not-an-address',
          amount: '0.01',
        }),
      ).rejects.toThrow(/Malformed/);
    });

    it('accumulates confirmations up to the network requirement', async () => {
      const created = await chain.createWithdrawal({
        idempotencyKey: 'wd-3',
        symbol: 'ETH',
        network: 'ethereum',
        address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        amount: '0.1',
      });

      let confirmations = 0;
      for (let i = 0; i < 10 && confirmations < created.data.requiredConfirmations; i += 1) {
        confirmations = (await chain.getConfirmations(created.data.externalId)).data;
      }
      expect(confirmations).toBe(created.data.requiredConfirmations);
    });
  });

  describe('KYCProvider', () => {
    it('approves by default and rejects on demand', async () => {
      const kyc = new MockKYCProvider();
      const input = {
        idempotencyKey: 'kyc-1',
        reference: 'user-1',
        fullName: 'Test Person',
        dateOfBirth: '1990-01-01',
        nationality: 'SO',
        country: 'SO',
        city: 'Mogadishu',
        addressLine: '1 Street',
        documentType: 'NATIONAL_ID',
        documentNumber: 'X123',
        email: 'a@example.com',
      };

      const approved = await kyc.createVerification(input);
      expect(approved.data.status).toBe('APPROVED');
      expect(approved.data.tier).toBe(1);

      mockScenarios.set('mock', 'KYC_REJECTED');
      const rejected = await kyc.createVerification({ ...input, idempotencyKey: 'kyc-2' });
      expect(rejected.data.status).toBe('REJECTED');
      expect(rejected.data.tier).toBe(0);
    });

    it('verifies webhook signatures', async () => {
      const kyc = new MockKYCProvider();
      const body = JSON.stringify({ eventId: 'k1', event: 'kyc.decided' });

      const good = await kyc.handleWebhook({
        rawBody: body,
        headers: { 'x-mock-signature': signMockKycWebhook(body) },
      });
      expect(good.signatureValid).toBe(true);

      const bad = await kyc.handleWebhook({
        rawBody: body,
        headers: { 'x-mock-signature': 'wrong' },
      });
      expect(bad.signatureValid).toBe(false);
    });
  });

  describe('WAAFI adapter', () => {
    // The point of these tests is to assert that the adapter is honestly
    // unimplemented rather than quietly guessing at WAAFI's API.
    const waafi = new WaafiPaymentProvider();

    it('refuses every operation with a specific missing dependency', async () => {
      const calls: [string, Promise<unknown>][] = [
        [
          'createDeposit',
          waafi.createDeposit({
            idempotencyKey: 'k',
            reference: 'r',
            amount: '1',
            currency: 'USD',
            payerAccountRef: '+252600000000',
          }),
        ],
        ['verifyDeposit', waafi.verifyDeposit('x')],
        [
          'createPayout',
          waafi.createPayout({
            idempotencyKey: 'k',
            reference: 'r',
            amount: '1',
            currency: 'USD',
            payeeAccountRef: '+252600000000',
          }),
        ],
        ['verifyPayout', waafi.verifyPayout('x')],
        ['handleWebhook', waafi.handleWebhook({ rawBody: '{}', headers: {} })],
      ];

      for (const [name, promise] of calls) {
        await expect(promise, name).rejects.toThrow(ProviderNotConfiguredError);
        await expect(promise, name).rejects.toThrow(/README/);
      }
    });
  });
});
