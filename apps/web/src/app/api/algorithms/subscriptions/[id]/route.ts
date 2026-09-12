import { z } from 'zod';
import { AlgorithmStatus } from '@flt/db';
import { setAlgorithmStatus } from '@flt/core/services/algorithms';
import { RateLimits } from '@flt/core/services/ratelimit';
import { routeHandler } from '@/server/api';

/**
 * Pause, resume or cancel one of the participant's own subscriptions.
 *
 * Ownership is enforced in the service (it filters by `userId`), so a stranger's
 * id yields NOT_FOUND rather than the row. Cancel never closes an open position —
 * stopping an algorithm is not a reason to force an exit at whatever the market
 * is doing.
 */
const schema = z.object({
  action: z.enum(['pause', 'resume', 'cancel']),
});

const STATUS_FOR: Record<'pause' | 'resume' | 'cancel', AlgorithmStatus> = {
  pause: 'PAUSED',
  resume: 'ACTIVE',
  cancel: 'CANCELLED',
};

export const POST = routeHandler<{ action: 'pause' | 'resume' | 'cancel' }, { id: string }, unknown>(
  { schema, rateLimit: { rule: RateLimits.API_GENERAL, scope: 'algorithm-status' } },
  async ({ body, params, user }) => {
    const updated = await setAlgorithmStatus(user, params.id, STATUS_FOR[body.action]);
    return { id: updated.id, status: updated.status };
  },
);
