import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from '../../domain/errors';
import type {
  ParsedWebhook,
  ProviderMeta,
  ProviderResult,
  WebhookRequest,
} from '../common';
import { MockStore, mockExternalId, mockScenarios } from '../mock-support';
import type {
  CreateVerificationInput,
  KYCProvider,
  Verification,
  VerificationStatus,
} from './types';

const PROVIDER = 'mock';

export const MOCK_KYC_WEBHOOK_SECRET = 'mock-kyc-webhook-secret';

/**
 * Identity verification, mocked.
 *
 * Default behaviour approves at tier 1 immediately, so local development is not
 * blocked on a manual review step. Scenarios force rejection and manual review
 * so those branches are exercised by tests.
 */
export class MockKYCProvider implements KYCProvider {
  readonly meta: ProviderMeta = { name: PROVIDER, kind: 'KYC', isSandbox: true };

  private readonly verifications = new MockStore<Verification>();

  reset(): void {
    this.verifications.clear();
  }

  async createVerification(
    input: CreateVerificationInput,
  ): Promise<ProviderResult<Verification>> {
    const replayed = this.verifications.findByIdempotencyKey(input.idempotencyKey);
    if (replayed) {
      return { data: replayed, externalId: replayed.externalId, raw: { replayed: true } };
    }

    const scenario = mockScenarios.get(PROVIDER);
    const externalId = mockExternalId('kyc', input.idempotencyKey);

    const status: VerificationStatus =
      mockScenarios.has(PROVIDER, 'KYC_REJECTED')
        ? 'REJECTED'
        : mockScenarios.has(PROVIDER, 'KYC_MANUAL_REVIEW')
          ? 'IN_REVIEW'
          : 'APPROVED';

    const verification: Verification = {
      externalId,
      status,
      tier: status === 'APPROVED' ? 1 : 0,
      reference: input.reference,
      rejectionReason:
        status === 'REJECTED' ? 'Document could not be matched to the applicant' : undefined,
      decidedAt: status === 'IN_REVIEW' ? undefined : new Date(),
    };

    this.verifications.put(externalId, verification, input.idempotencyKey);
    return { data: verification, externalId, raw: { scenario } };
  }

  async getVerificationStatus(externalId: string): Promise<ProviderResult<Verification>> {
    const verification = this.verifications.get(externalId);
    if (!verification) {
      throw new ProviderError(PROVIDER, `Unknown verification ${externalId}`);
    }
    return { data: verification, externalId };
  }

  async handleWebhook(request: WebhookRequest): Promise<ParsedWebhook> {
    const signature = request.headers['x-mock-signature'] ?? '';
    const expected = Buffer.from(
      createHmac('sha256', MOCK_KYC_WEBHOOK_SECRET).update(request.rawBody).digest('hex'),
      'utf8',
    );
    const actual = Buffer.from(signature, 'utf8');
    const signatureValid = expected.length === actual.length && timingSafeEqual(expected, actual);

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

    return {
      signatureValid,
      externalEventId: String(payload.eventId ?? ''),
      kind: 'KYC_DECIDED',
      eventType: String(payload.event ?? 'kyc.decided'),
      externalId: payload.verificationId ? String(payload.verificationId) : undefined,
      reference: payload.reference ? String(payload.reference) : undefined,
      occurredAt: payload.occurredAt ? new Date(String(payload.occurredAt)) : new Date(),
      raw: payload,
    };
  }

  /** Test helper: move a verification to a decision without a webhook. */
  decide(externalId: string, status: VerificationStatus, tier = 1): void {
    const existing = this.verifications.get(externalId);
    if (!existing) throw new ProviderError(PROVIDER, `Unknown verification ${externalId}`);
    this.verifications.put(externalId, { ...existing, status, tier, decidedAt: new Date() });
  }
}

export function signMockKycWebhook(rawBody: string): string {
  return createHmac('sha256', MOCK_KYC_WEBHOOK_SECRET).update(rawBody).digest('hex');
}
