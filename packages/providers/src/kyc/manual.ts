import { KycStatus, prisma } from '@flt/db';
import { ProviderNotConfiguredError } from '@flt/core/domain';
import type {
  KycProvider,
  ParsedKycWebhook,
  StartVerificationInput,
  StartVerificationResult,
  VerificationStatus,
} from './types.js';

/**
 * Manual review.
 *
 * The user's submission moves their profile to IN_REVIEW and it waits there
 * until a human with the COMPLIANCE role approves or rejects it in the admin
 * panel. There is no automated decision anywhere in this file — that is the
 * point.
 *
 * This is an honest control rather than a placeholder pretending to verify
 * identity. It does not scale, and it is the right Phase 1 answer: a real
 * provider can be integrated behind this same interface without any caller
 * changing.
 */
export class ManualReviewKycProvider implements KycProvider {
  readonly name = 'manual';
  readonly isManual = true;

  async startVerification(input: StartVerificationInput): Promise<StartVerificationResult> {
    // The profile row is written by the KYC service, which owns the account
    // state transition. Nothing to call out to.
    return {
      providerRef: `manual:${input.userId}`,
      status: KycStatus.IN_REVIEW,
      redirectUrl: null,
    };
  }

  async getStatus(providerRef: string): Promise<VerificationStatus> {
    const userId = providerRef.replace(/^manual:/, '');
    const profile = await prisma.kycProfile.findUnique({ where: { userId } });

    if (!profile) {
      return { status: KycStatus.NOT_STARTED, rejectionReason: null, decidedAt: null };
    }

    return {
      status: profile.status,
      rejectionReason: profile.rejectionReason,
      decidedAt: profile.decidedAt,
    };
  }

  async parseWebhook(): Promise<ParsedKycWebhook> {
    // Manual review has no upstream to send webhooks. Accepting one would mean
    // accepting an unauthenticated status change from the internet.
    throw new ProviderNotConfiguredError(
      this.name,
      'manual review has no webhook endpoint; decisions are made in the admin panel',
    );
  }
}
