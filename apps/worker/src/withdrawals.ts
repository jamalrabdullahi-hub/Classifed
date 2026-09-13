import { WithdrawalStatus, prisma, type Withdrawal } from '@flt/db';
import { custodyProvider } from '@flt/providers';
import { parseAbiItem, type Address } from 'viem';
import { publicClient } from '@flt/core/chains';
import { env } from '@flt/config';
import {
  claimWithdrawalForBroadcast,
  confirmWithdrawal,
  failWithdrawal,
  markWithdrawalSent,
  releaseWithdrawalClaim,
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

/** How far back to look for a transfer a lost broadcast may have produced. */
const RECOVERY_BLOCKS = 5_000n;

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/**
 * Looks on-chain for the transfer an ambiguous broadcast may have produced.
 *
 * A row sits in BROADCASTING when a send was attempted and its outcome is
 * unknown. Re-broadcasting would risk paying twice, so instead the chain is
 * asked: is there a transfer of exactly this amount, from the omnibus, to this
 * destination, in the recent past?
 *
 * Returns the hash if one is found, null if nothing is there. Null means the
 * broadcast provably never landed, which is the only condition under which the
 * row may safely go back to PENDING.
 *
 * Deliberately conservative: any failure reading the chain returns `undefined`
 * (unknown), which leaves the row where it is for an operator rather than
 * guessing.
 */
async function findBroadcastTransfer(
  withdrawal: Withdrawal,
): Promise<`0x${string}` | null | undefined> {
  const omnibus = env().OMNIBUS_EVM_ADDRESS;
  if (!omnibus) return undefined;

  const token = await prisma.token.findFirst({
    where: { chainId: withdrawal.chainId, symbol: withdrawal.asset, isEnabled: true },
  });
  if (!token) return undefined;

  try {
    const client = publicClient(withdrawal.chainId);
    const head = await client.getBlockNumber();
    const fromBlock = head > RECOVERY_BLOCKS ? head - RECOVERY_BLOCKS : 0n;

    const logs = await client.getLogs({
      address: token.address as Address,
      event: TRANSFER_EVENT,
      args: {
        from: omnibus as Address,
        to: withdrawal.destinationAddress as Address,
      },
      fromBlock,
      toBlock: head,
    });

    const match = logs.find(
      (log) => (log.args.value ?? 0n).toString() === withdrawal.amountBaseUnits,
    );
    return match ? (match.transactionHash as `0x${string}`) : null;
  } catch (error) {
    console.error('[withdrawals] could not search for a lost broadcast', {
      id: withdrawal.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export interface WithdrawalSweepResult {
  sent: number;
  completed: number;
  failed: number;
}

export async function processWithdrawals(): Promise<WithdrawalSweepResult> {
  const provider = custodyProvider();
  if (!provider) return { sent: 0, completed: 0, failed: 0 };

  const result: WithdrawalSweepResult = { sent: 0, completed: 0, failed: 0 };

  /**
   * Resolve anything left mid-flight by an earlier pass, before broadcasting
   * anything new — otherwise a row whose send was lost would be overtaken by a
   * fresh attempt at the same withdrawal.
   */
  const inFlight = await prisma.withdrawal.findMany({
    where: { status: WithdrawalStatus.BROADCASTING },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  for (const withdrawal of inFlight) {
    const found = await findBroadcastTransfer(withdrawal);

    if (found) {
      // It did leave. Adopt the hash so confirmation proceeds normally.
      await markWithdrawalSent(withdrawal.id, found);
      result.sent += 1;
      continue;
    }

    if (found === null) {
      // Nothing on-chain: the broadcast provably never landed, so retrying is
      // safe. This is the only path back to PENDING.
      await releaseWithdrawalClaim(
        withdrawal.id,
        'A broadcast attempt did not reach the chain; queued to send again',
      );
      continue;
    }

    // `undefined` — the chain could not be read, so we do not know. Left in
    // BROADCASTING deliberately: a stuck withdrawal is recoverable, a second
    // payment is not.
    console.error('[withdrawals] broadcast outcome unknown; leaving for review', {
      id: withdrawal.id,
      attempts: withdrawal.broadcastAttempts,
    });
  }

  const pending = await prisma.withdrawal.findMany({
    where: { status: WithdrawalStatus.PENDING },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  for (const withdrawal of pending) {
    /**
     * Claim it first. The status leaves PENDING before the send, so a send
     * whose response is lost cannot be mistaken for one that never happened —
     * the bug this replaces re-broadcast such a row 30 seconds later and paid
     * the participant twice. A null claim means another pass got there first.
     */
    const claimed = await claimWithdrawalForBroadcast(withdrawal.id);
    if (!claimed) continue;

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
      /**
       * Left in BROADCASTING, not returned to PENDING. The next pass asks the
       * chain what actually happened and only re-queues it if nothing left.
       */
      console.error('[withdrawals] broadcast failed; outcome will be checked on-chain', {
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
