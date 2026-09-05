import { ProviderNotConfiguredError } from '../../../domain/errors';
import type {
  ParsedWebhook,
  ProviderMeta,
  ProviderResult,
  WebhookRequest,
} from '../../common';
import type {
  CreateDepositInput,
  CreatePayoutInput,
  DepositIntent,
  PaymentProvider,
  PayoutIntent,
  VerifiedPayment,
  VerifiedPayout,
} from '../types';

const PROVIDER = 'waafi';

/**
 * WAAFI Pay adapter — NOT IMPLEMENTED.
 *
 * Every method below deliberately throws. Implementing them requires WAAFI's
 * merchant API documentation, which is not present in this repository. Guessing
 * at endpoints, field names, or the webhook signature scheme would produce code
 * that looks finished, passes review, and silently fails to move real money —
 * or worse, moves it incorrectly.
 *
 * README.md in this directory lists precisely what is needed. Once supplied,
 * only the transport details inside these five methods change; nothing outside
 * this directory has to be touched, because the rest of the application depends
 * on the PaymentProvider interface rather than on WAAFI.
 *
 * Until then, run with PAYMENT_PROVIDER=mock.
 */
export class WaafiPaymentProvider implements PaymentProvider {
  readonly meta: ProviderMeta = { name: PROVIDER, kind: 'PAYMENT', isSandbox: false };

  private notImplemented(operation: string, missing: string): never {
    throw new ProviderNotConfiguredError(
      PROVIDER,
      `${operation} requires ${missing}. See src/providers/payment/waafi/README.md.`,
    );
  }

  async createDeposit(_input: CreateDepositInput): Promise<ProviderResult<DepositIntent>> {
    this.notImplemented(
      'createDeposit',
      'the documented payment-request endpoint, its request/response schema, and the authentication scheme',
    );
  }

  async verifyDeposit(_externalId: string): Promise<ProviderResult<VerifiedPayment>> {
    this.notImplemented(
      'verifyDeposit',
      'the documented transaction-status endpoint and its response schema',
    );
  }

  async createPayout(_input: CreatePayoutInput): Promise<ProviderResult<PayoutIntent>> {
    this.notImplemented(
      'createPayout',
      'the documented disbursement endpoint and confirmation that the merchant account is enabled for payouts',
    );
  }

  async verifyPayout(_externalId: string): Promise<ProviderResult<VerifiedPayout>> {
    this.notImplemented(
      'verifyPayout',
      'the documented disbursement-status endpoint and its response schema',
    );
  }

  async handleWebhook(_request: WebhookRequest): Promise<ParsedWebhook> {
    this.notImplemented(
      'handleWebhook',
      'the webhook payload schema, the signature algorithm, the header carrying the signature, and a stable per-event identifier for replay protection',
    );
  }
}
