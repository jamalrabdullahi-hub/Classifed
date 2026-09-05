import type { AccountType } from '@flt/db';

/**
 * Risk engine interface — a Phase 2 extension point.
 *
 * Phase 1 ships `NoopRiskEngine`, which allows everything. The interface exists
 * now, and is CALLED on the quote path now, specifically so that Phase 2
 * replaces one line in the provider registry instead of threading a new call
 * site through the trade services and re-testing the whole path.
 *
 * Nothing in Phase 1 computes margin, leverage, volatility, ADR, PDT-style
 * restrictions or insurance premiums. Building a schema for an engine whose
 * requirements are not settled would be guesswork.
 */

export interface TradeRiskContext {
  userId: string;
  accountType: AccountType;
  chainId: number;
  walletAddress: string;

  sellTokenAddress: string;
  buyTokenAddress: string;
  /** Base units. */
  sellAmount: string;
  buyAmount: string;

  /** Estimated, from the quote service. Null when it could not be computed. */
  priceImpactBps: number | null;
  /** Notional value of the trade, when market data is available. */
  notionalUsd: string | null;
}

export type RiskOutcome = 'ALLOW' | 'WARN' | 'BLOCK';

export interface RiskDecision {
  outcome: RiskOutcome;
  /**
   * Machine-readable reasons. Empty on a plain ALLOW.
   * e.g. `['PRICE_IMPACT_ELEVATED']`
   */
  reasons: string[];
  /** Shown to the user on WARN, and as the refusal reason on BLOCK. */
  message?: string;
}

export interface RiskEngine {
  readonly name: string;

  /**
   * Assessed before a firm quote is returned to the user.
   *
   * BLOCK refuses the quote. WARN returns it with a caution attached, so the
   * user makes an informed decision rather than being silently stopped.
   */
  assessTrade(context: TradeRiskContext): Promise<RiskDecision>;
}

export const ALLOW: RiskDecision = { outcome: 'ALLOW', reasons: [] };
