import { agentStatusFor } from '@flt/core/services/agent-trading';
import { ValidationError } from '@flt/core/domain';
import { bridgeHandler } from '@/server/bridge-auth';

/**
 * The agent's own configuration — what an EA should treat as its trading
 * limits, so a misconfigured EA fails a local check before it ever sends a
 * signal that the server would reject anyway.
 */
export const GET = bridgeHandler({}, async ({ user }) => {
  const status = await agentStatusFor(user);
  if (!status.agent) {
    throw new ValidationError('No trading agent is configured for this account.');
  }

  return {
    status: status.agent.status,
    allocatedUsdHyperliquid: status.agent.allocatedUsdHyperliquid,
    allocatedUsdOstium: status.agent.allocatedUsdOstium,
    maxLeverage: status.agent.maxLeverage,
    symbols: status.agent.symbols.split(','),
    protectionRequired: status.agent.protectionRequired,
    venues: status.keys
      .filter((key) => key.authorizedAt)
      .map((key) => ({ venue: key.venueSlug, address: key.address })),
  };
});
