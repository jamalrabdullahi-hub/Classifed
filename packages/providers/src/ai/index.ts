import { env } from '@flt/config';
import { ProviderNotConfiguredError } from '@flt/core/domain';
import { resolveAiSettings } from '@flt/core/services/platform-settings';
import { OpenAiProvider } from './openai';
import { MockAiProvider } from './mock';
import type { AiProvider } from './types';

/**
 * The AI trader's provider, resolved from the stored settings (admin panel),
 * falling back to the environment.
 *
 * Off unless enabled. In production a real key is required; outside production
 * the literal key `mock` selects the deterministic mock so the path can be
 * exercised without a network call.
 */

export async function aiEnabled(): Promise<boolean> {
  return (await resolveAiSettings()).enabled;
}

export async function aiProvider(): Promise<AiProvider> {
  const settings = await resolveAiSettings();
  if (!settings.enabled) {
    throw new ProviderNotConfiguredError('ai', 'AI trading is not enabled');
  }

  if (env().NODE_ENV !== 'production' && settings.apiKey === 'mock') {
    return new MockAiProvider();
  }

  if (!settings.apiKey) {
    throw new ProviderNotConfiguredError('ai', 'No AI API key is configured');
  }

  return new OpenAiProvider({
    apiUrl: settings.apiUrl,
    apiKey: settings.apiKey,
    model: settings.model,
  });
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
