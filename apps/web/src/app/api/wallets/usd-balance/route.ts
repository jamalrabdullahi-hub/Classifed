import { custodyPortfolio } from '@flt/core/services/portfolio-usd';
import { handler } from '@/server/api';

/**
 * The participant's balance, read from the custody ledger.
 *
 * Not a chain read: under custody the funds are pooled in the omnibus, so what
 * a participant holds is what FLT owes them, and the chain is used only to
 * price the assets. See `custodyPortfolio`.
 */
export const GET = handler({}, async ({ user }) => {
  return custodyPortfolio(user.id);
});
