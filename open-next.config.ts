import { defineCloudflareConfig } from '@opennextjs/cloudflare';

/**
 * OpenNext adapter configuration.
 *
 * No incremental cache is configured. Every route in this application is
 * server-rendered on demand and most read money — caching a rendered balance
 * or an order status would be worse than useless. If static caching is added
 * later it must exclude everything under /admin and /api.
 */
export default defineCloudflareConfig();
