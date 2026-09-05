/**
 * Insurance engine interface — a Phase 2 extension point.
 *
 * Defined so the shape of the eventual integration is agreed, and deliberately
 * NOT wired into any Phase 1 code path. Phase 1 sells no coverage, quotes no
 * premiums and holds no policies.
 *
 * The future system is expected to support account insurance, leveraged-position
 * insurance, total and unrealized coverage, trailing coverage, ticker-specific
 * risk thresholds, dynamic premiums and systemic-event coverage. None of that
 * is modelled here, because the premium model is an actuarial decision rather
 * than a technical one, and inventing a schema for it now would be guesswork
 * that Phase 2 has to unpick.
 */

export type CoverageKind =
  | 'ACCOUNT'
  | 'POSITION'
  | 'TOTAL'
  | 'UNREALIZED'
  | 'TRAILING'
  | 'SYSTEMIC_EVENT';

export interface CoverageQuoteRequest {
  userId: string;
  kind: CoverageKind;
  chainId: number;
  /** Subject of the coverage: a token, a position, or the account as a whole. */
  subjectRef: string;
  notionalUsd: string;
}

export interface CoverageQuote {
  eligible: boolean;
  /** Null when not eligible. */
  premiumUsd: string | null;
  /** Machine-readable ineligibility reasons. */
  reasons: string[];
  expiresAt: Date;
}

export interface InsuranceProvider {
  readonly name: string;
  isEligible(request: CoverageQuoteRequest): Promise<boolean>;
  quoteCoverage(request: CoverageQuoteRequest): Promise<CoverageQuote>;
}
