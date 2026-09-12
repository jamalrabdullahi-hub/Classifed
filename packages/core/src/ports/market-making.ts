import type { PerpAccountRef, PerpVenue } from './perps';

/**
 * The market-making extension of a perpetual venue.
 *
 * A participant venue (`PerpVenue`) prepares actions for a *person* to sign.
 * FLT's automated book is a different animal: it is FLT quoting its own capital,
 * signed server-side by the venue agent key (see docs/adr/0007). Rather than
 * widen the participant contract — and force every venue, including ones that
 * cannot host a book, to grow methods they will never use — the maker's needs
 * live here, on a venue that opts in by implementing this interface.
 *
 * `OstiumVenue` deliberately does not implement it: the maker runs on
 * Hyperliquid (ADR 0007 §2), and a venue that cannot host the book should not
 * have to pretend it can.
 */

/** A resting order the venue reports for an account. */
export interface OpenOrder {
  symbol: string;
  /** The venue's own order id. */
  oid: number;
  /** The client order id this order was placed with, when it carried one. */
  cloid: string | null;
  isBuy: boolean;
  price: string;
  size: string;
}

/** A trade the venue reports for an account, reduced to what the maker needs. */
export interface VenueFill {
  /** The venue's trade id — the dedup key. */
  venueTid: string;
  venueOid: number | null;
  symbol: string;
  isBuy: boolean;
  price: string;
  size: string;
  /** The venue fee, in USD (negative is a rebate). */
  feeUsd: string;
  /** Realized PnL the venue books on this fill, in USD. */
  closedPnlUsd: string;
  filledAt: Date;
  venueHash: string | null;
}

/**
 * One quote to rest.
 *
 * Post-only by construction: the maker adds liquidity and never takes, so every
 * quote that reaches a venue here is submitted add-liquidity-only. A quote that
 * would cross is rejected by the venue, not quietly converted into a taker.
 */
export interface MakerQuote {
  assetId: number;
  symbol: string;
  isBuy: boolean;
  /** Already rounded to the venue's price tick. */
  price: string;
  /** Already rounded to the market's size decimals. */
  size: string;
  /** Deterministic client order id, so a retried requote cannot double-place. */
  cloid: string;
}

export interface MakerQuoteRequest {
  address: string;
  symbol: string;
  isBuy: boolean;
  price: string;
  size: string;
  cloid: string;
}

/** One order to pull. Identified by venue oid, client order id, or both. */
export interface MakerCancel {
  assetId: number;
  oid?: number | null;
  cloid?: string | null;
}

export interface MakerCancelRequest {
  address: string;
  cancels: Array<{ symbol: string; oid?: number | null; cloid?: string | null }>;
}

/**
 * A maker action, prepared by the venue for the agent key to sign.
 *
 * Kept separate from `PreparedAction` on purpose: a maker action is never a
 * person's order, and the one place that signs participant actions
 * (`submitPrepared`) should not have to know how to sign the house's. The two
 * signing paths stay disjoint — see ADR 0007.
 */
export type MakerAction =
  | { kind: 'maker-quotes'; endpoint: string; quotes: MakerQuote[] }
  | { kind: 'maker-cancel'; endpoint: string; cancels: MakerCancel[] };

/**
 * A venue that can host FLT's automated book.
 *
 * `supportsMarketMaking` is a literal `true` rather than a boolean so a
 * `PerpVenue` can be narrowed to this type with a runtime check
 * (`'supportsMarketMaking' in venue`) instead of a bare cast that would lie
 * about `OstiumVenue`.
 */
export interface MarketMakingVenue extends PerpVenue {
  readonly supportsMarketMaking: true;
  getOpenOrders(account: PerpAccountRef): Promise<OpenOrder[]>;
  getFills(account: PerpAccountRef, since?: Date): Promise<VenueFill[]>;
  prepareMakerQuote(request: MakerQuoteRequest): Promise<MakerAction>;
  prepareMakerCancel(request: MakerCancelRequest): Promise<MakerAction>;
}
