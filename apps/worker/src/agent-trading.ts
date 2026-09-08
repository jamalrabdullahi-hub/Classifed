import { prisma, TradingAgentStatus } from '@flt/db';
import { env } from '@flt/config';
import { Decimal, newId } from '@flt/core/domain';
import { HistoricalStdDev, toDailySigma } from '@flt/core/protection';
import { perpVenueBySlug, requestTradeDecision, executeAgentDecision, type MarketSnapshot } from '@flt/providers';

/**
 * One pass: for every active agent, on every venue it has an authorised key
 * for, ask the model for a decision on each of its allowed symbols and act
 * on what the risk service accepts.
 *
 * Sequential across agents rather than parallel — this is the one job in the
 * worker that spends real money if it goes wrong, and the interval is long
 * enough (see AGENT_TRADING_INTERVAL_MS in index.ts) that there is no
 * throughput reason to parallelise it.
 */
export async function runAgentTradingPass(): Promise<{ decisions: number; executed: number }> {
  if (!env().AGENTIC_TRADING_ENABLED) return { decisions: 0, executed: 0 };

  const agents = await prisma.tradingAgent.findMany({
    where: { status: TradingAgentStatus.ACTIVE },
    include: { keys: true, user: true },
  });

  let decisions = 0;
  let executed = 0;

  for (const agent of agents) {
    if (agent.user.accountStatus !== 'KYC_APPROVED' || agent.user.tradingDisabled) continue;

    const venueSlugs = agent.keys
      .filter((key) => key.authorizedAt !== null)
      .map((key) => key.venueSlug as 'hyperliquid' | 'ostium');

    const symbols = agent.symbols.split(',').map((s) => s.trim()).filter(Boolean);

    for (const venueSlug of venueSlugs) {
      const venue = perpVenueBySlug(venueSlug);
      if (!venue) continue;

      const allocatedUsd =
        venueSlug === 'hyperliquid' ? agent.allocatedUsdHyperliquid : agent.allocatedUsdOstium;
      if (!allocatedUsd) continue;

      const markets: MarketSnapshot[] = [];
      for (const symbol of symbols) {
        try {
          const market = await venue.getMarket(symbol);
          if (!market?.markPrice) continue;

          const candles = await venue.getCandles(symbol, '1h', 169);
          const volatility = toDailySigma(new HistoricalStdDev().calculate(candles, 169, 1 / 24));

          const positions = await venue.getPositions({
            address: agent.keys.find((k) => k.venueSlug === venueSlug)!.address,
          });
          const position = positions.find((p) => p.symbol === market.symbol);

          markets.push({
            symbol: market.symbol,
            markPrice: market.markPrice,
            fundingRateAnnualised: market.fundingRate
              ? new Decimal(market.fundingRate).times(24 * 365 / market.fundingIntervalHours).toFixed(4)
              : null,
            dailyVolatilityPct: volatility.times(100).toFixed(2),
            openInterest: market.openInterest,
            currentPosition: position
              ? { side: position.side, size: position.size, unrealizedPnl: position.unrealizedPnl }
              : null,
          });
        } catch (error) {
          console.error(`[agent-trading] snapshot failed for ${venueSlug}:${symbol}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (markets.length === 0) continue;

      let raw: string;
      let decision: Awaited<ReturnType<typeof requestTradeDecision>>['decision'];
      try {
        const result = await requestTradeDecision({
          markets,
          maxLeverage: Math.min(agent.maxLeverage, env().AGENT_MAX_LEVERAGE_CAP),
          allocatedUsdHyperliquid: agent.allocatedUsdHyperliquid,
          allocatedUsdOstium: agent.allocatedUsdOstium,
        });
        raw = result.raw;
        decision = result.decision;
      } catch (error) {
        console.error(`[agent-trading] DeepSeek call failed for agent ${agent.id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      decisions += 1;

      const outcome = await executeAgentDecision({
        user: agent.user,
        agent,
        keys: agent.keys,
        venueSlug,
        decision,
      });

      if (outcome.accepted && outcome.action !== 'HOLD') executed += 1;

      await prisma.agentDecision.create({
        data: {
          id: newId(),
          agentId: agent.id,
          venueSlug,
          symbol: decision.symbol,
          contextJson: JSON.stringify({ markets, maxLeverage: agent.maxLeverage }),
          rawResponse: raw,
          action: outcome.action,
          side: decision.side ?? null,
          leverage: decision.leverage ?? null,
          usdNotional: decision.usdNotional !== undefined ? String(decision.usdNotional) : null,
          reasoning: decision.reasoning ?? null,
          accepted: outcome.accepted,
          rejectionReason: outcome.rejectionReason,
          orderId: outcome.orderId,
        },
      });
    }
  }

  return { decisions, executed };
}
