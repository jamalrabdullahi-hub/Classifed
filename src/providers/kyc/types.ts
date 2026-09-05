import type {
  ParsedWebhook,
  ProviderMeta,
  ProviderResult,
  WebhookRequest,
} from '../common';

export type VerificationStatus =
  | 'PENDING'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED';

export interface CreateVerificationInput {
  idempotencyKey: string;
  /** Our user id, echoed back by the vendor so webhooks can be matched. */
  reference: string;
  fullName: string;
  dateOfBirth: string;
  nationality: string;
  country: string;
  city: string;
  addressLine: string;
  documentType: string;
  documentNumber: string;
  email: string;
  phone?: string;
}

export interface Verification {
  externalId: string;
  status: VerificationStatus;
  /** Assurance level granted. Drives the customer's trading and withdrawal limits. */
  tier: number;
  reference?: string;
  rejectionReason?: string;
  /** Vendor-hosted flow, for vendors that take over the document capture step. */
  redirectUrl?: string;
  decidedAt?: Date;
}

/**
 * Identity verification.
 *
 * Sanctions and PEP screening belong behind this same interface, but WHAT must
 * be screened and retained for the Somali market is a compliance policy decision,
 * not something this code can infer. See src/providers/kyc/README.md.
 */
export interface KYCProvider {
  readonly meta: ProviderMeta;

  createVerification(input: CreateVerificationInput): Promise<ProviderResult<Verification>>;
  getVerificationStatus(externalId: string): Promise<ProviderResult<Verification>>;
  handleWebhook(request: WebhookRequest): Promise<ParsedWebhook>;
}
