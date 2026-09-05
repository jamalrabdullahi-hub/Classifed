import { createHmac, timingSafeEqual } from 'node:crypto';
import { Decimal } from '../../domain/money';
import { ProviderError } from '../../domain/errors';
import type {
  ParsedWebhook,
  ProviderMeta,
  ProviderResult,
  WebhookRequest,
} from '../common';
import { MockStore, mockExternalId, mockScenarios } from '../mock-support';
import type {
  CreateDepositInput,
  CreatePayoutInput,
  DepositIntent,
  PaymentProvider,
  PaymentStatus,
  PayoutIntent,
  VerifiedPayment,
  VerifiedPayout,
} from './types';

const PROVIDER = 'mock';

/** Development-only webhook secret. The real adapter reads this from env. */
export const MOCK_WEBHOOK_SECRET = 'mock-webhook-secret';

interface MockPayment {
  externalId: string;
  reference: string;
  status: PaymentStatus;
  amount: string;
  currency: string;
  fee: string;
  accountRef: string;
  paidAt?: Date;
  failureReason?: string;
}

/**
 * In-memory payment provider standing in for WAAFI Pay.
 *
 * It models the parts of a mobile-money flow the application must handle:
 * a deposit that is pending until confirmed, an out-of-band verify step, a
 * provider fee, signed webhooks, and stable event ids for replay protection.
 *
 * It does NOT imitate WAAFI's actual request/response shapes — those are unknown
 * to this codebase. See ./waafi/README.md.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly meta: ProviderMeta = { name: PROVIDER, kind: 'PAYMENT', isSandbox: true };

  /** Flat 1% provider fee, deducted from the gross amount. */
  private readonly feeBps = 100;
  private readonly deposits = new MockStore<MockPayment>();
  private readonly payouts = new MockStore<MockPayment>();

  reset(): void {
    this.deposits.clear();
    this.payouts.clear();
  }

  async createDeposit(input: CreateDepositInput): Promise<ProviderResult<DepositIntent>> {
    const replayed = this.deposits.findByIdempotencyKey(input.idempotencyKey);
    if (replayed) {
      return { data: this.toIntent(replayed), externalId: replayed.externalId };
    }

    const scenario = mockScenarios.get(PROVIDER);
    if (mockScenarios.has(PROVIDER, 'PROVIDER_TIMEOUT')) {
      throw new ProviderError(PROVIDER, 'Payment provider timed out', { retryable: true });
    }

    const externalId = mockExternalId('pay', input.idempotencyKey);
    const fee = new Decimal(input.amount).times(this.feeBps).dividedBy(10_000).toDecimalPlaces(2);

    const payment: MockPayment = {
      externalId,
      reference: input.reference,
      // A real mobile-money push is never instantly settled; the customer must
      // approve it. Confirmation arrives by webhook or by verifyDeposit polling.
      status: 'AWAITING_PAYMENT',
      amount: input.amount,
      currency: input.currency,
      fee: fee.toFixed(2),
      accountRef: input.payerAccountRef,
    };
    this.deposits.put(externalId, payment, input.idempotencyKey);

    return {
      data: {
        ...this.toIntent(payment),
        instructions: `Approve the ${input.currency} ${input.amount} payment request on ${input.payerAccountRef}.`,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
      externalId,
      raw: { scenario },
    };
  }

  private toIntent(payment: MockPayment): DepositIntent {
    return {
      externalId: payment.externalId,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      fee: payment.fee,
    };
  }

  async verifyDeposit(externalId: string): Promise<ProviderResult<VerifiedPayment>> {
    const payment = this.deposits.get(externalId);
    if (!payment) {
      throw new ProviderError(PROVIDER, `Unknown payment ${externalId}`);
    }

    // The scenario decides what the provider reports on this verification.
    const scenario = mockScenarios.get(PROVIDER);
    if (mockScenarios.has(PROVIDER, 'PAYMENT_PENDING')) {
      return { data: { ...payment, status: 'AWAITING_PAYMENT' }, externalId };
    }
    if (mockScenarios.has(PROVIDER, 'PAYMENT_FAILED')) {
      const failed: MockPayment = {
        ...payment,
        status: 'FAILED',
        failureReason: 'Customer declined the payment request',
      };
      this.deposits.put(externalId, failed);
      return { data: failed, externalId };
    }

    const settled: MockPayment = {
      ...payment,
      status: 'SUCCEEDED',
      paidAt: payment.paidAt ?? new Date(),
    };
    this.deposits.put(externalId, settled);
    return {
      data: {
        externalId: settled.externalId,
        status: settled.status,
        amount: settled.amount,
        currency: settled.currency,
        fee: settled.fee,
        reference: settled.reference,
        paidAt: settled.paidAt,
      },
      externalId,
    };
  }

  async createPayout(input: CreatePayoutInput): Promise<ProviderResult<PayoutIntent>> {
    const replayed = this.payouts.findByIdempotencyKey(input.idempotencyKey);
    if (replayed) {
      return { data: this.toIntent(replayed), externalId: replayed.externalId };
    }

    const scenario = mockScenarios.get(PROVIDER);
    if (mockScenarios.has(PROVIDER, 'PROVIDER_TIMEOUT')) {
      throw new ProviderError(PROVIDER, 'Payment provider timed out', { retryable: true });
    }

    const externalId = mockExternalId('out', input.idempotencyKey);
    const fee = new Decimal(input.amount).times(this.feeBps).dividedBy(10_000).toDecimalPlaces(2);

    const payout: MockPayment = {
      externalId,
      reference: input.reference,
      status: mockScenarios.has(PROVIDER, 'PAYMENT_FAILED') ? 'FAILED' : 'SUCCEEDED',
      amount: input.amount,
      currency: input.currency,
      fee: fee.toFixed(2),
      accountRef: input.payeeAccountRef,
      paidAt: new Date(),
      ...(mockScenarios.has(PROVIDER, 'PAYMENT_FAILED')
        ? { failureReason: 'Destination account rejected the transfer' }
        : {}),
    };
    this.payouts.put(externalId, payout, input.idempotencyKey);

    return { data: this.toIntent(payout), externalId };
  }

  async verifyPayout(externalId: string): Promise<ProviderResult<VerifiedPayout>> {
    const payout = this.payouts.get(externalId);
    if (!payout) {
      throw new ProviderError(PROVIDER, `Unknown payout ${externalId}`);
    }
    return {
      data: {
        externalId: payout.externalId,
        status: payout.status,
        amount: payout.amount,
        currency: payout.currency,
        fee: payout.fee,
        reference: payout.reference,
        paidAt: payout.paidAt,
        failureReason: payout.failureReason,
      },
      externalId,
    };
  }

  async handleWebhook(request: WebhookRequest): Promise<ParsedWebhook> {
    const signature = request.headers['x-mock-signature'] ?? '';
    const signatureValid = verifyMockSignature(request.rawBody, signature);

    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(request.rawBody) as Record<string, unknown>;
    } catch {
      return {
        signatureValid: false,
        externalEventId: 'unparseable',
        kind: 'UNKNOWN',
        raw: request.rawBody,
      };
    }

    const eventType = String(payload.event ?? 'unknown');
    const kind =
      eventType === 'deposit.succeeded'
        ? ('DEPOSIT_SUCCEEDED' as const)
        : eventType === 'deposit.failed'
          ? ('DEPOSIT_FAILED' as const)
          : eventType === 'payout.succeeded'
            ? ('PAYOUT_SUCCEEDED' as const)
            : eventType === 'payout.failed'
              ? ('PAYOUT_FAILED' as const)
              : ('UNKNOWN' as const);

    return {
      signatureValid,
      externalEventId: String(payload.eventId ?? ''),
      kind,
      eventType,
      externalId: payload.paymentId ? String(payload.paymentId) : undefined,
      reference: payload.reference ? String(payload.reference) : undefined,
      amount: payload.amount ? String(payload.amount) : undefined,
      currency: payload.currency ? String(payload.currency) : undefined,
      occurredAt: payload.occurredAt ? new Date(String(payload.occurredAt)) : new Date(),
      raw: payload,
    };
  }
}

export function signMockWebhook(rawBody: string, secret = MOCK_WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifyMockSignature(rawBody: string, signature: string): boolean {
  const expected = Buffer.from(signMockWebhook(rawBody), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
