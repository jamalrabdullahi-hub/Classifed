import { handler } from '@/server/api';
import { getTransactionHistory } from '@/services/history';

/** Complete history, derived from the ledger. */
export const GET = handler({}, async ({ userId, request }) => {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? '50');
  return getTransactionHistory(userId, {
    limit: Number.isFinite(limit) ? limit : 50,
  });
});
