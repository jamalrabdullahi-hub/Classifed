import type {
  ParsedWebhook,
  ProviderMeta,
  ProviderResult,
  WebhookRequest,
} from '../common';

export type PaymentStatus = 'PENDING' | 'AWAITING_PAYMENT' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';

export interface CreateDepositInput {
  idempotencyKey: string;
  /** Our own reference, echoed back by the provider where supported. */
  reference: string;
  amount: string;
  currency: string;
  /** The customer account funds are pulled from (for WAAFI, an MSISDN). */
  payerAccountRef: string;
  description?: string;
}

export interface DepositIntent {
  externalId: string;
  status: PaymentStatus;
  amount: string;
  currency: string;
  /** Provider-side cost deducted from the gross amount, if the provider charges one. */
  fee?: string;
  /** Where to send the customer to authorise, if the provider uses a redirect. */
  redirectUrl?: string;
  /** Free-form instructions to display (e.g. a USSD string). */
  instructions?: string;
  expiresAt?: Date;
}

export interface VerifiedPayment {
  externalId: string;
  status: PaymentStatus;
  amount: string;
  currency: string;
  fee?: string;
  reference?: string;
  paidAt?: Date;
  failureReason?: string;
}

export interface CreatePayoutInput {
  idempotencyKey: string;
  reference: string;
  amount: string;
  currency: string;
  /** Destination customer account (for WAAFI, an MSISDN). */
  payeeAccountRef: string;
  description?: string;
}

export interface PayoutIntent {
  externalId: string;
  status: PaymentStatus;
  amount: string;
  currency: string;
  fee?: string;
}

export interface VerifiedPayout {
  externalId: string;
  status: PaymentStatus;
  amount: string;
  currency: string;
  fee?: string;
  reference?: string;
  paidAt?: Date;
  failureReason?: string;
}

/**
 * Moves fiat between a customer and the brokerage.
 *
 * `verifyDeposit` is not optional politeness: a webhook body alone NEVER credits
 * a customer. The deposit service always confirms out-of-band through this
 * method before posting to the ledger.
 */
export interface PaymentProvider {
  readonly meta: ProviderMeta;

  createDeposit(input: CreateDepositInput): Promise<ProviderResult<DepositIntent>>;
  verifyDeposit(externalId: string): Promise<ProviderResult<VerifiedPayment>>;

  createPayout(input: CreatePayoutInput): Promise<ProviderResult<PayoutIntent>>;
  verifyPayout(externalId: string): Promise<ProviderResult<VerifiedPayout>>;

  handleWebhook(request: WebhookRequest): Promise<ParsedWebhook>;
}
