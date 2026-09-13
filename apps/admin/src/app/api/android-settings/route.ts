import { z } from 'zod';
import { PERMISSIONS } from '@flt/core/services/admin';
import {
  resolveAndroidAppSettings,
  setAndroidAppSettings,
} from '@flt/core/services/platform-settings';
import { adminHandler } from '@/server/api';

/**
 * Where people download the Android app.
 *
 * MANAGE_PLATFORM_SETTINGS: this decides which file every sideloading user
 * installs, so it sits with the other settings that point people at money or
 * software, not with per-account controls.
 */
const schema = z.object({
  playUrl: z.string().trim().max(300),
  apkUrl: z.string().trim().max(300),
  apkVersion: z.string().trim().max(32),
  apkSha256: z.string().trim().max(64),
});

export const GET = adminHandler<unknown, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PLATFORM_SETTINGS },
  async () => resolveAndroidAppSettings(),
);

export const POST = adminHandler<z.infer<typeof schema>, unknown, unknown>(
  { permission: PERMISSIONS.MANAGE_PLATFORM_SETTINGS, schema },
  async ({ body, admin, context }) => {
    await setAndroidAppSettings(
      { admin, ip: context.ip, userAgent: context.userAgent, requestId: context.requestId },
      body,
    );
    return resolveAndroidAppSettings();
  },
);
