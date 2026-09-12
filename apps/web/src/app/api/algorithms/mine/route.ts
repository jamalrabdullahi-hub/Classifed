import { listUserAlgorithms } from '@flt/core/services/algorithms';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/** The signed-in participant's own algorithm subscriptions. */
export const GET = handler(
  { rateLimit: { rule: RateLimits.API_GENERAL, scope: 'algorithms-mine' } },
  async ({ user }) => ({ algorithms: await listUserAlgorithms(user.id) }),
);
