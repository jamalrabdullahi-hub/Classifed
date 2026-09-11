import { WithdrawalStatus, prisma } from '@flt/db';
import { custodyProvider } from '@flt/providers';
import {
  confirmWithdrawal,
  failWithdrawal,
  markWithdrawalSent,
} from '@flt/core/services/withdrawals';

/**
 * The withdrawal pipeline.
 *
 * Two stages, each safe to repeat:
 *
 *   1. **Broadcast** each PENDING request from the omnibus and record the hash.
 *      The funds were already locked at request time, so nothing else can spend
 *      them in the meantime.
 *   2. **Confirm** each SENT request against a mined receipt — then debit the
 *      ledger; or, if it reverted, release the reservation.
 *
 * No-ops when custody is off, so a deployment without an omnibus runs nothing.
 */

const BATCH = 50;

export interface WithdrawalSweepResult {
  sent: number;
  completed: number;
  failed: number;
}

export async function processWithdrawals(): Promise<WithdrawalSweepResult> {
  const provider = custodyProvider();
  if (!provider) return { sent: 0, completed: 0, failed: 0 };

  const result: WithdrawalSweepResult = { sent: 0, completed: 0, failed: 0 };

  const pending = await prisma.withdrawal.findMany({
    where: { status: WithdrawalStatus.PENDING },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  for (const withdrawal of pending) {
    try {
      const sent = await provider.requestWithdrawal({
        idempotencyKey: withdrawal.id,
        asset: withdrawal.asset,
        chainId: withdrawal.chainId,
        amount: withdrawal.amountBaseUnits,
        destinationAddress: withdrawal.destinationAddress,
      });
      if (!sent.txHash) throw new Error('the omnibus returned no transaction hash');
      await markWithdrawalSent(withdrawal.id, sent.txHash);
      result.sent += 1;
    } catch (error) {
      // Left PENDING to retry. A transient broadcast failure must not strand
      // the funds as FAILED — the reservation is intact and the next pass
      // tries again.
      console.error('[withdrawals] broadcast failed', {
        id: withdrawal.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const sentRows = await prisma.withdrawal.findMany({
    where: { status: WithdrawalStatus.SENT },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  for (const withdrawal of sentRows) {
    if (!withdrawal.txHash) continue;
    try {
      const state = await provider.getWithdrawal(withdrawal.txHash);

      if (state?.status === 'failed') {
        await failWithdrawal(withdrawal.id, state.failureReason ?? 'Transfer reverted on-chain');
        result.failed += 1;
        continue;
      }
      if (state?.status !== 'completed') continue;

      const { completed } = await confirmWithdrawal(withdrawal.id);
      if (completed) result.completed += 1;
    } catch (error) {
      console.error('[withdrawals] confirmation failed', {
        id: withdrawal.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
