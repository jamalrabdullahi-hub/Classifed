/**
 * Reserve the sell amount for the live-test swap, mirroring what
 * /api/trades/execute does before it broadcasts. Runs once; idempotent.
 */
import { prisma, isUniqueViolation, TransactionStatus } from '@flt/db';
import { lockFunds } from '@flt/core/services/ledger';
import { Decimal } from '@flt/core/domain';

async function main(): Promise<void> {
  const tx = await prisma.transaction.findFirst({
    where: { status: TransactionStatus.SUBMITTED, user: { email: 'trader@fltexchange.local' } },
    orderBy: { submittedAt: 'desc' },
  });
  if (!tx?.quoteId) throw new Error('No SUBMITTED transaction for the trader.');

  try {
    await lockFunds({
      userId: tx.userId,
      asset: 'USDC',
      amount: new Decimal('0.9'),
      reference: `trade-lock:${tx.quoteId}`,
      memo: 'Live-test reservation for the swap',
    });
    console.info('locked 0.9 USDC');
  } catch (error) {
    if (isUniqueViolation(error)) console.info('already locked');
    else throw error;
  }
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
