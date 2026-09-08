import { z } from 'zod';
import {
  agentStatusFor,
  configureAgent,
  AGENT_DISCLOSURE_VERSION,
  AGENT_DISCLOSURE_POINTS,
} from '@flt/core/services/agent-trading';
import { handler } from '@/server/api';

/**
 * The AI trading agent's own configuration.
 *
 * GET returns the current state including every signing key's public
 * address — never the key itself, which never leaves
 * `@flt/core/security/agent-keys`. POST creates or reconfigures it.
 */
const schema = z.object({
  venues: z.array(z.enum(['hyperliquid', 'ostium'])).min(1),
  allocatedUsdHyperliquid: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/)
    .nullish(),
  allocatedUsdOstium: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/)
    .nullish(),
  maxLeverage: z.coerce.number().int().min(1).max(20),
  symbols: z.array(z.string().trim().min(1).max(20)).min(1).max(10),
  disclosureAcceptedVersion: z.string(),
});

export const GET = handler({}, async ({ user }) => {
  const status = await agentStatusFor(user);
  return {
    agent: status.agent
      ? {
          status: status.agent.status,
          allocatedUsdHyperliquid: status.agent.allocatedUsdHyperliquid,
          allocatedUsdOstium: status.agent.allocatedUsdOstium,
          maxLeverage: status.agent.maxLeverage,
          symbols: status.agent.symbols.split(','),
          protectionRequired: status.agent.protectionRequired,
          killSwitchReason: status.agent.killSwitchReason,
        }
      : null,
    keys: status.keys.map((key) => ({
      venueSlug: key.venueSlug,
      address: key.address,
      authorized: key.authorizedAt !== null,
    })),
    eligible: status.eligible,
    disclosureVersion: AGENT_DISCLOSURE_VERSION,
    disclosurePoints: AGENT_DISCLOSURE_POINTS,
  };
});

export const POST = handler({ schema }, async ({ body, user }) => {
  const agent = await configureAgent(user, {
    venues: body.venues,
    allocatedUsdHyperliquid: body.allocatedUsdHyperliquid ?? null,
    allocatedUsdOstium: body.allocatedUsdOstium ?? null,
    maxLeverage: body.maxLeverage,
    symbols: body.symbols,
    disclosureAcceptedVersion: body.disclosureAcceptedVersion,
  });

  const keys = await agentStatusFor(user);

  return {
    status: agent.status,
    keys: keys.keys.map((key) => ({ venueSlug: key.venueSlug, address: key.address })),
  };
});
