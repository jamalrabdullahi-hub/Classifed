import type { KycStatus } from '@flt/db';

/**
 * KYC provider abstraction.
 *
 * Phase 1 deliberately does NOT ship a fake automated verifier. A system that
 * prints "verified" without checking anything is worse than no system: it looks
 * finished, and the gap is discovered during an audit rather than during
 * development.
 *
 * What ships instead is `ManualReviewKycProvider` — the user submits, a human
 * with the COMPLIANCE role decides. That is a real, if unscalable, control, and
 * it sits behind the same interface that Persona, Sumsub or Onfido will
 * implement later.
 */

export interface StartVerificationInput {
  userId: string;
  email: string;
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: Date;
  countryCode: string;
}

export interface StartVerificationResult {
  /** The provider's reference, when it issues one. */
  providerRef: string | null;
  status: KycStatus;
  /**
   * Where to send the user to complete verification, for hosted-flow providers.
   * Null for manual review, which needs no redirect.
   */
  redirectUrl: string | null;
}

export interface VerificationStatus {
  status: KycStatus;
  rejectionReason: string | null;
  decidedAt: Date | null;
}

/** Normalized inbound webhook, for providers that decide asynchronously. */
export interface ParsedKycWebhook {
  signatureValid: boolean;
  /** Replay guard — stored under a unique index by the caller. */
  externalEventId: string;
  providerRef: string;
  status: KycStatus;
  rejectionReason: string | null;
  occurredAt: Date;
}

export interface KycProvider {
  readonly name: string;
  /** True when decisions are made by a human in the admin panel. */
  readonly isManual: boolean;

  startVerification(input: StartVerificationInput): Promise<StartVerificationResult>;
  getStatus(providerRef: string): Promise<VerificationStatus>;

  /**
   * Parses an inbound webhook.
   *
   * MUST verify the signature against the RAW request bytes, never against a
   * re-serialized object — re-serialization changes the bytes and makes any
   * signature check meaningless.
   */
  parseWebhook(rawBody: string, headers: Record<string, string>): Promise<ParsedKycWebhook>;
}
