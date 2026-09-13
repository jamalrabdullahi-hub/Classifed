import { env } from '@flt/config';
import { ProviderError } from '@flt/core/domain';
import type { AiAction, AiDecision, AiDecisionRequest, AiProvider } from './types';

/**
 * OpenAI-compatible chat client.
 *
 * Pointed at `AI_API_URL`, so it works with OpenAI, OpenRouter, Azure-style
 * gateways, or a local model that speaks the same wire format. It asks for a
 * JSON object and validates it strictly — a model that returns prose, an
 * unknown action, or a symbol outside the allowed set is a provider failure, not
 * a trade.
 */

const ALLOWED_ACTIONS: readonly AiAction[] = ['OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'HOLD'];

function systemMessage(request: AiDecisionRequest): string {
  return [
    request.systemPrompt?.trim() ||
      'You are a disciplined derivatives trader. You choose at most one action.',
    'Reply with ONLY a JSON object of the form:',
    '{"action":"OPEN_LONG|OPEN_SHORT|CLOSE|HOLD","symbol":"<one of the allowed symbols or null>","confidence":<0..1>,"rationale":"<short reason>"}',
    `Allowed symbols: ${request.allowedSymbols.join(', ')}.`,
    `Maximum leverage available: ${request.maxLeverage}x.`,
    'Prefer HOLD when the picture is unclear. Never invent a symbol.',
  ].join('\n');
}

function userMessage(request: AiDecisionRequest): string {
  return [
    `The participant asked: ${request.userPrompt}`,
    '',
    'Current markets:',
    JSON.stringify(request.markets, null, 2),
  ].join('\n');
}

export function parseDecision(raw: string, request: AiDecisionRequest): AiDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderError('ai', 'The model did not return valid JSON');
  }

  const obj = parsed as Record<string, unknown>;
  const action = obj.action;
  if (typeof action !== 'string' || !ALLOWED_ACTIONS.includes(action as AiAction)) {
    throw new ProviderError('ai', `The model returned an unknown action: ${String(action)}`);
  }

  const symbol = typeof obj.symbol === 'string' ? obj.symbol : null;
  if (action !== 'HOLD' && (!symbol || !request.allowedSymbols.includes(symbol))) {
    throw new ProviderError('ai', `The model chose a symbol outside the allowed set: ${String(symbol)}`);
  }

  const confidenceRaw = typeof obj.confidence === 'number' ? obj.confidence : 0;
  const confidence = Math.max(0, Math.min(1, confidenceRaw));
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.slice(0, 500) : '';

  return { action: action as AiAction, symbol, confidence, rationale };
}

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';

  async decide(request: AiDecisionRequest): Promise<AiDecision> {
    const config = env();
    if (!config.AI_API_KEY) {
      throw new ProviderError('ai', 'AI_API_KEY is not configured');
    }

    let response: Response;
    try {
      response = await fetch(`${config.AI_API_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.AI_API_KEY}`,
        },
        body: JSON.stringify({
          model: config.AI_MODEL,
          messages: [
            { role: 'system', content: systemMessage(request) },
            { role: 'user', content: userMessage(request) },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        }),
      });
    } catch (error) {
      throw new ProviderError('ai', 'Could not reach the model endpoint', {
        retryable: true,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }

    if (!response.ok) {
      throw new ProviderError('ai', `Model request failed (${response.status})`, {
        retryable: response.status >= 500 || response.status === 429,
        details: { status: response.status },
      });
    }

    const payload = (await response.json().catch(() => null)) as
      | { choices?: { message?: { content?: string } }[] }
      | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new ProviderError('ai', 'The model returned an empty response');

    return parseDecision(content, request);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const config = env();
    if (!config.AI_API_KEY) return { ok: false, detail: 'AI_API_KEY is not set' };
    return { ok: true, detail: `${config.AI_MODEL} at ${config.AI_API_URL}` };
  }
}
