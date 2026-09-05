/**
 * Shared provider vocabulary.
 *
 * Rules that hold for every adapter in this directory:
 *   1. Amounts cross the boundary as decimal STRINGS, never JS numbers.
 *   2. Every mutating call takes an explicit `idempotencyKey` supplied by the
 *      caller, so a retry after a timeout cannot double-execute.
 *   3. Vendor-specific payload shapes never escape the adapter. Callers see
 *      only the normalized types below.
 *   4. `raw` carries the untouched vendor response for the audit trail; no
 *      business logic may read it.
 */

export type ProviderKind =
  | 'PAYMENT'
  | 'LIQUIDITY'
  | 'BLOCKCHAIN'
  | 'KYC'
  | 'DEX'
  | 'SCREENING';

export interface ProviderMeta {
  /** Stable identifier persisted on records, e.g. "mock", "waafi". */
  readonly name: string;
  readonly kind: ProviderKind;
  /** False when the adapter is talking to real money. */
  readonly isSandbox: boolean;
}

/** Every adapter method returns this so callers get a uniform audit surface. */
export interface ProviderResult<T> {
  data: T;
  /** The vendor's own identifier for this operation, when it issues one. */
  externalId?: string;
  raw?: unknown;
}

export interface WebhookRequest {
  /** The exact bytes received. Signature verification MUST use this, not a re-serialized object. */
  rawBody: string;
  headers: Record<string, string>;
}

export type WebhookEventKind =
  | 'DEPOSIT_SUCCEEDED'
  | 'DEPOSIT_FAILED'
  | 'PAYOUT_SUCCEEDED'
  | 'PAYOUT_FAILED'
  | 'KYC_DECIDED'
  | 'UNKNOWN';

/**
 * The normalized result of parsing an inbound webhook.
 *
 * `externalEventId` is the replay guard — it is stored under a unique index.
 * A provider that does not supply a stable event id forces the adapter to derive
 * one deterministically from the payload, and to say so explicitly.
 */
export interface ParsedWebhook {
  signatureValid: boolean;
  externalEventId: string;
  kind: WebhookEventKind;
  eventType?: string;
  /** The provider's reference for the deposit/payout/verification concerned. */
  externalId?: string;
  /** Our own reference, if the provider echoes it back. */
  reference?: string;
  amount?: string;
  currency?: string;
  occurredAt?: Date;
  raw: unknown;
}

export interface ProviderFee {
  amount: string;
  currency: string;
}
