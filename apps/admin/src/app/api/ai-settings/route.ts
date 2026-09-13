import { z } from 'zod';
import { PERMISSIONS } from '@flt/core/services/admin';
import { aiKeyIsSet, resolveAiSettings, setAiSettings } from '@flt/core/services/platform-settings';
import { adminHandler } from '@/server/api';

/**
 * The AI trader's model credentials.
 *
 * Held to MANAGE_PLATFORM_SETTINGS (SUPER_ADMIN only): this is a live
 * third-party API key and the switch that lets the platform trade on a model's
 * say-so — a wider decision than any per-account control.
 */
const schema = z.object({
  enabled: z.boolean(),
  apiUrl: z.string().trim().url(),
  model: z.string().trim().min(1).max(80),
  /** Omitted or empty keeps the existing key. */
  apiKey: z.string().trim().max(300).optional(),
  reason: z.string().trim().min(8).max(500),
});

export const GET = adminHandler<unknown, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PLATFORM_SETTINGS },
  async () => {
    const settings = await resolveAiSettings();
    return {
      enabled: settings.enabled,
      apiUrl: settings.apiUrl,
      model: settings.model,
      keySet: await aiKeyIsSet(),
    };
  },
);

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PLATFORM_SETTINGS, schema },
  async ({ body, admin, context }) => {
    await setAiSettings(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      { enabled: body.enabled, apiUrl: body.apiUrl, model: body.model, apiKey: body.apiKey },
    );
    return { keySet: await aiKeyIsSet() };
  },
);
