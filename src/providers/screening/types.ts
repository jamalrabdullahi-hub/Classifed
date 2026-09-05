import type { ProviderMeta, ProviderResult } from '../common';

/**
 * Blockchain analytics.
 *
 * This is the control that turns "permissionless blockchain" into something a
 * compliance function can actually supervise. It runs at three points:
 *
 *   1. **Incoming crypto** — before a deposit is credited.
 *   2. **Withdrawal destinations** — before we send anything out.
 *   3. **Counterparties** — before treasury interacts with an address.
 *
 * A screening result is cached with an expiry. Risk is not a permanent property
 * of an address: an address that was clean last month can be sanctioned today,
 * and a stale ACCEPT is precisely how tainted funds get in.
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'SEVERE' | 'UNKNOWN';

/**
 * Categories a vendor may report. Deliberately a broad union rather than an
 * exhaustive enum — vendors differ, and the adapter maps their taxonomy onto
 * this one. `OTHER` carries the vendor's own label in `detail`.
 */
export type RiskCategory =
  | 'SANCTIONS'
  | 'TERRORIST_FINANCING'
  | 'STOLEN_FUNDS'
  | 'RANSOMWARE'
  | 'DARKNET'
  | 'MIXER'
  | 'SCAM'
  | 'FRAUD'
  | 'GAMBLING'
  | 'HIGH_RISK_EXCHANGE'
  | 'CHILD_ABUSE_MATERIAL'
  | 'OTHER';

export interface RiskFinding {
  category: RiskCategory;
  /** 0-100, vendor-normalized. Higher is worse. */
  severity: number;
  /** How many hops away the exposure is. Direct exposure is far more serious. */
  hops?: number;
  /** Share of the subject's volume attributable to this category, in bps. */
  exposureBps?: number;
  detail?: string;
}

export type Decision = 'ACCEPT' | 'REVIEW' | 'REJECT';

export interface ScreeningVerdict {
  subject: string;
  chain: string;
  risk: RiskLevel;
  /** Vendor's composite score, when they give one. */
  score?: number;
  findings: RiskFinding[];
  /**
   * The adapter's recommendation. The DECISION IS OURS — see
   * src/services/screening.ts, which applies our policy on top of this.
   */
  decision: Decision;
  /** When this verdict stops being trustworthy. */
  expiresAt?: Date;
  raw?: unknown;
}

export interface ScreenAddressInput {
  address: string;
  chain: string;
  /** Which direction we are considering, since risk appetite differs. */
  direction: 'INBOUND' | 'OUTBOUND';
}

export interface ScreenTransactionInput {
  txHash: string;
  chain: string;
  /** The address we care about within that transaction. */
  address?: string;
}

export interface ScreeningProvider {
  readonly meta: ProviderMeta;

  screenAddress(input: ScreenAddressInput): Promise<ProviderResult<ScreeningVerdict>>;
  screenTransaction(input: ScreenTransactionInput): Promise<ProviderResult<ScreeningVerdict>>;
}
