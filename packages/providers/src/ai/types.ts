/**
 * The AI trader's model boundary.
 *
 * The provider turns a participant's words plus a compact market snapshot into
 * ONE decision — open long, open short, close, or hold — with a rationale. It
 * never sizes or prices an order and never touches funds: the runner converts
 * the decision into an order through the ordinary custody path, under the same
 * insurance, leverage and balance checks as a manual trade. The model decides
 * *direction*; it does not get to bypass anything.
 */

export type AiAction = 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'HOLD';

export interface AiMarketSnapshot {
  symbol: string;
  markPrice: string | null;
  /** Signed percent change over the last 24h, if known. */
  change24hPct: string | null;
  /** A short recent close series, oldest first — enough to see the shape. */
  closes: number[];
  /** What the participant already holds on this market, or null if flat. */
  currentSide: 'LONG' | 'SHORT' | null;
}

export interface AiDecisionRequest {
  /** The offering's system prompt ("prompt on rails"). */
  systemPrompt: string | null;
  /** The participant's own prompt. */
  userPrompt: string;
  allowedSymbols: string[];
  maxLeverage: number;
  markets: AiMarketSnapshot[];
}

export interface AiDecision {
  action: AiAction;
  /** The symbol the action applies to; null only for HOLD. */
  symbol: string | null;
  /** 0..1 — the model's stated confidence. Advisory. */
  confidence: number;
  rationale: string;
}

export interface AiProvider {
  readonly name: string;
  decide(request: AiDecisionRequest): Promise<AiDecision>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}
