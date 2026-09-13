import type { AiDecision, AiDecisionRequest, AiProvider } from './types';

/**
 * A deterministic stand-in for the model, for development only.
 *
 * It makes the same shape of decision the real provider would — following the
 * last bar's direction — so the whole AI path (activation, run, order, fee) can
 * be exercised without a key or a network call. It is refused in production by
 * the provider factory.
 */
export class MockAiProvider implements AiProvider {
  readonly name = 'mock';

  async decide(request: AiDecisionRequest): Promise<AiDecision> {
    const market = request.markets.find((candidate) =>
      request.allowedSymbols.includes(candidate.symbol),
    );
    if (!market || market.closes.length < 2) {
      return { action: 'HOLD', symbol: null, confidence: 0.1, rationale: 'Not enough history.' };
    }

    const first = market.closes[market.closes.length - 2]!;
    const last = market.closes[market.closes.length - 1]!;
    const side = last >= first ? 'OPEN_LONG' : 'OPEN_SHORT';

    return {
      action: side,
      symbol: market.symbol,
      confidence: 0.5,
      rationale: `Mock: last move ${first} -> ${last}.`,
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'mock' };
  }
}
