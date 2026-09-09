import { z } from 'zod';
import { env } from '@flt/config';
import { PERMISSIONS } from '@flt/core/services/admin';
import {
  agenticTradingOperational,
  deepSeekApiKeyConfigured,
  setAgenticTradingEnabled,
  setDeepSeekApiKey,
} from '@flt/core/services/platform-settings';
import { adminHandler } from '@/server/api';

/**
 * The agentic-trading platform switch and its DeepSeek key.
 *
 * GET never returns the key itself — only whether one is configured. POST
 * accepts a new key (write-only, same as changing a password) or the
 * enabled toggle; the service layer re-checks MANAGE_PLATFORM_SETTINGS
 * regardless of what this route's own permission gate already enforced.
 */
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('toggle'), enabled: z.boolean() }),
  z.object({ action: z.literal('set-key'), apiKey: z.string().trim().min(10).max(200) }),
]);

export const GET = adminHandler<unknown, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PLATFORM_SETTINGS },
  async () => {
    const [operational, keyConfigured] = await Promise.all([
      agenticTradingOperational(),
      deepSeekApiKeyConfigured(),
    ]);
    return {
      enabled: operational,
      deepSeekKeyConfigured: keyConfigured,
      encryptionKeyConfigured: Boolean(env().AGENT_KEY_ENCRYPTION_KEY),
    };
  },
);

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PLATFORM_SETTINGS, schema },
  async ({ body, admin, context }) => {
    const actionContext = { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId };

    if (body.action === 'toggle') {
      await setAgenticTradingEnabled(actionContext, body.enabled);
      return { enabled: body.enabled };
    }

    await setDeepSeekApiKey(actionContext, body.apiKey);
    return { deepSeekKeyConfigured: true };
  },
);
