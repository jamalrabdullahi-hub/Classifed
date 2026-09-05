import { handler } from '@/server/api';
import { prisma } from '@/server/db';
import { getUserBalances } from '@/services/ledger';

/** Balances are derived from ledger projections, never from a stored figure. */
export const GET = handler({}, async ({ userId }) => {
  const balances = await getUserBalances(prisma, userId);
  return balances.map((b) => ({
    symbol: b.symbol,
    name: b.name,
    kind: b.kind,
    quoteScale: b.quoteScale,
    available: b.available.toFixed(b.quoteScale),
    held: b.held.toFixed(b.quoteScale),
    total: b.total.toFixed(b.quoteScale),
  }));
});
