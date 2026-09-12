import { listAlgorithms } from '@flt/core/services/algorithms';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * The algorithm catalog.
 *
 * Public, like the perps market list: somebody deciding whether to buy should be
 * able to see what is on offer before they sign in. Buying still requires a
 * session and a funded balance — only the listing is open.
 */
export const GET = handler(
  { auth: false, rateLimit: { rule: RateLimits.API_GENERAL, scope: 'algorithms' } },
  async () => ({ algorithms: await listAlgorithms() }),
);
