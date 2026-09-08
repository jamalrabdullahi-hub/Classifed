import { z } from 'zod';
import { prisma } from '@flt/db';
import { agentStatusFor } from '@flt/core/services/agent-trading';
import { ValidationError, newId } from '@flt/core/domain';
import { executeAgentDecision, type DeepSeekDecision } from '@flt/providers';
import { bridgeHandler } from '@/server/bridge-auth';

/**
 * One trade signal from a participant's own MT4/5 Expert Advisor.
 *
 * This is deliberately the same door the AI agent walks through:
 * `executeAgentDecision` re-validates the signal against the participant's
 * own TradingAgent configuration (allocation, leverage cap, symbol allowlist,
 * mandatory protection) regardless of what the EA sent. An EA that has gone
 * rogue, or a key used from a compromised terminal, can propose anything —
 * it cannot get a bigger position, a higher leverage, an unlisted symbol or
 * an unprotected position than the participant already configured.
 */
const schema = z.object({
  venue: z.enum(['hyperliquid', 'ostium']),
  action: z.enum(['OPEN', 'CLOSE']),
  symbol: z.string().trim().min(1).max(24),
  side: z.enum(['LONG', 'SHORT']).optional(),
  leverage: z.number().int().positive().optional(),
  usdNotional: z.union([z.string(), z.number()]).optional(),
  /** Free text from the EA — e.g. "MT5 EOD close signal" — logged verbatim. */
  reasoning: z.string().trim().max(500).optional(),
});

export const POST = bridgeHandler({ schema }, async ({ body, user }) => {
  const status = await agentStatusFor(user);
  if (!status.agent) {
    throw new ValidationError('No trading agent is configured for this account.');
  }

  const decision: DeepSeekDecision = {
    action: body.action,
    symbol: body.symbol,
    venue: body.venue,
    side: body.side,
    leverage: body.leverage,
    usdNotional: body.usdNotional,
    reasoning: body.reasoning ?? 'Signal from MT4/5 bridge',
  };

  const outcome = await executeAgentDecision({
    user,
    agent: status.agent,
    keys: status.keys,
    venueSlug: body.venue,
    decision,
  });

  // Same audit trail an AI decision leaves — a support ticket or the
  // participant's own history should not be able to tell the two apart
  // except by contextJson naming the source.
  await prisma.agentDecision.create({
    data: {
      id: newId(),
      agentId: status.agent.id,
      venueSlug: body.venue,
      symbol: body.symbol,
      contextJson: JSON.stringify({ source: 'mt-bridge' }),
      rawResponse: JSON.stringify(body),
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

  return outcome;
});
