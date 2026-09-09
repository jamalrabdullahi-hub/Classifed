import { usdBalanceSummary } from '@flt/core/services/portfolio-usd';
import { handler } from '@/server/api';

/**
 * One combined $ figure across every wallet the account has — the
 * auto-provisioned embedded wallet and any manually linked ones. Display
 * only; see the module doc on `usdBalanceSummary` for what this is not.
 */
export const GET = handler({}, async ({ user }) => {
  return usdBalanceSummary(user.id);
});
