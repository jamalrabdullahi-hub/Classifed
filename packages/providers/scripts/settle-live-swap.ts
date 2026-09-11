/**
 * Settle the live-test swap that confirmed before the registry lookup was fixed.
 * Reads the received buy-token amount from the mined receipt and posts the
 * TRADE_SETTLEMENT. Idempotent on the transaction id.
 */
import { prisma, TransactionKind } from '@flt/db';
import { settleCustodyTradeAfterConfirm } from '@flt/core/services/custody-trades';
import { publicClient } from '@flt/core/chains';
import { env } from '@flt/config';
import { decodeEventLog, erc20Abi } from 'viem';

async function main(): Promise<void> {
  const tx = await prisma.transaction.findFirst({
    where: { kind: TransactionKind.SWAP, user: { email: 'trader@fltexchange.local' } },
    orderBy: { submittedAt: 'desc' },
  });
  if (!tx?.quoteId || !tx.txHash) throw new Error('No swap transaction found.');

  const quote = await prisma.quote.findUnique({ where: { id: tx.quoteId } });
  if (!quote) throw new Error('Quote not found.');
  const omnibus = env().OMNIBUS_EVM_ADDRESS!.toLowerCase();

  const receipt = await publicClient(8453).waitForTransactionReceipt({
    hash: tx.txHash as `0x${string}`,
  });
  console.info(`swap receipt: ${receipt.status} (block ${receipt.blockNumber})`);

  // What actually reached the omnibus, in base units of the buy token.
  let received = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== quote.buyTokenAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (
        decoded.eventName === 'Transfer' &&
        (decoded.args.to as string).toLowerCase() === omnibus
      ) {
        received += decoded.args.value;
      }
    } catch {
      // not a Transfer log
    }
  }
  console.info(`received buy token: ${received.toString()} (wei)`);

  await settleCustodyTradeAfterConfirm(prisma, {
    transactionId: tx.id,
    userId: tx.userId,
    quoteId: tx.quoteId,
    receivedBaseUnits: received.toString(),
  });
  console.info('settled');
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
