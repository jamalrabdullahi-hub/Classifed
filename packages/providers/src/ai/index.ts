import { env } from '@flt/config';
import { ProviderNotConfiguredError } from '@flt/core/domain';
import { OpenAiProvider } from './openai';
import { MockAiProvider } from './mock';
import type { AiProvider } from './types';

/**
 * The AI trader's provider, resolved.
 *
 * Off unless `AI_ENABLED`. In production a real key is required; outside
 * production the literal key `mock` selects the deterministic mock so the path
 * can be exercised without a network call. Anything else is the real client.
 */

export function aiEnabled(): boolean {
  return env().AI_ENABLED;
}

export function aiProvider(): AiProvider {
  const config = env();
  if (!config.AI_ENABLED) {
    throw new ProviderNotConfiguredError('ai', 'AI_ENABLED is not set');
  }

  if (config.NODE_ENV !== 'production' && config.AI_API_KEY === 'mock') {
    return new MockAiProvider();
  }

  if (!config.AI_API_KEY) {
    throw new ProviderNotConfiguredError('ai', 'AI_API_KEY is not set');
  }

  return new OpenAiProvider();
}

export type {
  AiAction,
  AiDecision,
  AiDecisionRequest,
  AiMarketSnapshot,
  AiProvider,
} from './types';
export { OpenAiProvider } from './openai';
export { MockAiProvider } from './mock';
