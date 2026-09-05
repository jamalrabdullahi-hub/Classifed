import { ALLOW, type RiskDecision, type RiskEngine, type TradeRiskContext } from './types';

/**
 * Phase 1 risk engine: allows everything.
 *
 * This is not a stub that throws or a TODO comment — it is a real
 * implementation of the interface that makes the correct Phase 1 decision,
 * which is "FLT does not restrict trades." The user's own wallet, the price
 * impact ceiling in the quote service, and the on-chain `minBuyAmount` floor
 * are the protections that exist today.
 *
 * Replacing this with a real engine is one line in the provider registry.
 */
export class NoopRiskEngine implements RiskEngine {
  readonly name = 'noop';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async assessTrade(_context: TradeRiskContext): Promise<RiskDecision> {
    return ALLOW;
  }
}
