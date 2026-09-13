import { z } from 'zod';
import { AlgorithmStatus } from '@flt/db';
import { setAlgorithmStatus, updateAlgorithmSettings } from '@flt/core/services/algorithms';
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
  action: z.enum(['pause', 'resume', 'cancel', 'settings']),
  /** For `settings`: the new leverage, markets, size and guardrails. */
  settings: z.record(z.unknown()).optional(),
  strategyParams: z.record(z.unknown()).optional(),
});

type Body = z.infer<typeof schema>;

const STATUS_FOR: Record<'pause' | 'resume' | 'cancel', AlgorithmStatus> = {
  pause: 'PAUSED',
  resume: 'ACTIVE',
  cancel: 'CANCELLED',
};

/**
 * `settings` edits a running subscription in place. It is not a cancel: no fee
 * is settled and the history is kept, and the change applies from the next run.
 */
export const POST = routeHandler<Body, { id: string }, unknown>(
  { schema, rateLimit: { rule: RateLimits.API_GENERAL, scope: 'algorithm-status' } },
  async ({ body, params, user }) => {
    if (body.action === 'settings') {
      const updated = await updateAlgorithmSettings(user, params.id, {
        settings: body.settings,
        strategyParams: body.strategyParams,
      });
      return { id: updated.id, status: updated.status };
    }
    const updated = await setAlgorithmStatus(user, params.id, STATUS_FOR[body.action]);
    return { id: updated.id, status: updated.status };
  },
);
