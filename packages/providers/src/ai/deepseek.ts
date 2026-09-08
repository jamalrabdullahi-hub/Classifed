import { z } from 'zod';
import { env } from '@flt/config';

/**
 * The trade-decision model.
 *
 * DeepSeek's chat completions API is OpenAI-compatible, which is the whole
 * reason it is easy to swap: nothing here is DeepSeek-specific beyond the
 * base URL and model name, both of which come from env. A cheaper or better
 * model is a config change, not a rewrite.
 *
 * ## The model proposes; it does not decide
 *
 * Nothing this function returns is trusted. The caller (the executor) runs
 * every field through `@flt/core/services/agent-risk` before it can touch a
 * venue, and the raw response is logged in full on `AgentDecision.rawResponse`
 * regardless of what happens next — an audit trail that starts with "trust
 * the model" is not an audit trail.
 */

export interface MarketSnapshot {
  symbol: string;
  markPrice: string;
  fundingRateAnnualised: string | null;
  dailyVolatilityPct: string;
  openInterest: string | null;
  currentPosition: { side: 'LONG' | 'SHORT'; size: string; unrealizedPnl: string | null } | null;
}

export interface AgentDecisionRequest {
  markets: MarketSnapshot[];
  maxLeverage: number;
  allocatedUsdHyperliquid: string | null;
  allocatedUsdOstium: string | null;
}

const decisionSchema = z.object({
  action: z.enum(['OPEN', 'CLOSE', 'HOLD']),
  symbol: z.string(),
  venue: z.enum(['hyperliquid', 'ostium']).optional(),
  side: z.enum(['LONG', 'SHORT']).optional(),
  leverage: z.number().optional(),
  usdNotional: z.union([z.string(), z.number()]).optional(),
  reasoning: z.string().optional(),
});

export type DeepSeekDecision = z.infer<typeof decisionSchema>;

const SYSTEM_PROMPT = `You are a risk-averse trading assistant proposing at most one action for a leveraged perpetual futures account you do not control directly.

Rules you must follow:
- Respond with a single JSON object matching this shape exactly, no prose outside it:
  {"action":"OPEN"|"CLOSE"|"HOLD","symbol":string,"venue":"hyperliquid"|"ostium","side":"LONG"|"SHORT" (only for OPEN),"leverage":number (only for OPEN),"usdNotional":string (only for OPEN),"reasoning":string}
- Never propose leverage above the stated maximum.
- Never propose a usdNotional above the stated allocation for that venue.
- Prefer HOLD when signals are mixed or volatility is elevated relative to typical for the symbol. Being wrong costs the participant real money — the safe default is doing nothing.
- Every OPEN or CLOSE must name exactly one symbol from the markets provided. Never invent a symbol.
- "reasoning" must be a short, plain-language explanation a non-expert can read, not a restatement of the input numbers.`;

/** Raised on anything that means the response cannot be trusted as a decision. */
export class DeepSeekDecisionError extends Error {}

export async function requestTradeDecision(
  request: AgentDecisionRequest,
): Promise<{ decision: DeepSeekDecision; raw: string }> {
  const config = env();
  if (!config.DEEPSEEK_API_KEY) {
    throw new DeepSeekDecisionError('DEEPSEEK_API_KEY is not configured.');
  }

  const userContent = JSON.stringify({
    markets: request.markets,
    maxLeverage: request.maxLeverage,
    allocatedUsdHyperliquid: request.allocatedUsdHyperliquid,
    allocatedUsdOstium: request.allocatedUsdOstium,
  });

  const response = await fetch(`${config.DEEPSEEK_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.DEEPSEEK_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new DeepSeekDecisionError(`DeepSeek returned ${response.status}: ${body.slice(0, 500)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = payload.choices?.[0]?.message?.content ?? '';
  if (!raw) throw new DeepSeekDecisionError('DeepSeek returned no content.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeepSeekDecisionError('DeepSeek response was not valid JSON.');
  }

  const result = decisionSchema.safeParse(parsed);
  if (!result.success) {
    throw new DeepSeekDecisionError(`DeepSeek response did not match the expected shape: ${result.error.message}`);
  }

  return { decision: result.data, raw };
}
