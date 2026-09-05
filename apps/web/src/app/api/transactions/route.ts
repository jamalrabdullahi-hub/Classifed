import { prisma } from '@flt/db';
import { listTransactions } from '@flt/core/services/trades';
import { handler } from '@/server/api';

export const GET = handler({}, async ({ user, request }) => {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 25);

  const transactions = await listTransactions(prisma, user.id, { limit });

  return transactions.map((transaction) => ({
    id: transaction.id,
    kind: transaction.kind,
    status: transaction.status,
    txHash: transaction.txHash,
    chainId: transaction.chainId,
    sellTokenAddress: transaction.sellTokenAddress,
    buyTokenAddress: transaction.buyTokenAddress,
    amountOutActual: transaction.amountOutActual,
    tamperDetected: transaction.tamperDetected,
    submittedAt: transaction.submittedAt.toISOString(),
    confirmedAt: transaction.confirmedAt?.toISOString() ?? null,
  }));
});
