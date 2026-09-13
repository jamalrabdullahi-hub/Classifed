import {
  ActorType,
  TransactionKind,
  TransactionStatus,
  prisma,
  type Transaction,
} from '@flt/db';
import { env } from '@flt/config';
import { decodeEventLog, erc20Abi, type Log } from 'viem';
import { publicClient } from '@flt/core/chains';
import { addressesEqual, isNativeToken } from '@flt/core/domain';
import { calldataHash } from '@flt/core/services/crypto/hashing';
import { AuditAction, audit } from '@flt/core/services/audit';
import { transitionTransaction } from '@flt/core/services/trades';
import { OPEN_TRANSACTION_STATUSES } from '@flt/core/domain';

/**
 * Transaction monitor.
 *
 * FLT does not broadcast, so this is the only way we learn what happened: ask
 * the chain. Everything recorded here is what the chain actually did, kept
 * distinct from what the quote predicted — those are different numbers and
 * conflating them would be the beginning of claiming an accuracy we do not
 * have.
 *
 * Three jobs:
 *   1. Resolve pending transactions to CONFIRMED, REVERTED or DROPPED.
 *   2. Verify the mined calldata matches the quote we issued.
 *   3. Extract the actual amount received from the logs.
 */

const DROPPED_AFTER_MS = 10 * 60 * 1_000;

/**
 * When a transaction with no receipt is treated as never going to be mined.
 *
 * DROPPED is not terminal — a congested transaction often mines well after the
 * ten-minute mark, and under custody the reservation backing it must stay held
 * until the chain has actually decided. This is the point at which waiting
 * longer is less useful than releasing: a day without inclusion means the
 * transaction is not coming back, and FAILED is what releases the reservation.
 *
 * Deliberately far longer than DROPPED_AFTER_MS. The old behaviour released at
 * ten minutes and then settled the same trade if it mined afterwards, spending
 * one reservation twice.
 */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1_000;

export interface MonitorResult {
  checked: number;
  confirmed: number;
  reverted: number;
  dropped: number;
  tampered: number;
}

export async function runMonitorPass(): Promise<MonitorResult> {
  const open = await prisma.transaction.findMany({
    where: { status: { in: [...OPEN_TRANSACTION_STATUSES] } },
    // The wallet is needed to tell which Transfer landed with the taker.
    include: { quote: true, wallet: true },
    orderBy: { submittedAt: 'asc' },
    take: 100,
  });

  const result: MonitorResult = {
    checked: open.length,
    confirmed: 0,
    reverted: 0,
    dropped: 0,
    tampered: 0,
  };

  for (const transaction of open) {
    try {
      const outcome = await checkTransaction(transaction);
      if (outcome === 'CONFIRMED') result.confirmed += 1;
      if (outcome === 'REVERTED') result.reverted += 1;
      if (outcome === 'DROPPED') result.dropped += 1;
      if (outcome === 'TAMPERED') result.tampered += 1;
    } catch (error) {
      // One unreachable transaction must not stop the pass. It stays open and
      // is retried next time.
      console.error('[monitor] failed to check transaction', {
        id: transaction.id,
        txHash: transaction.txHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

type Outcome = 'CONFIRMED' | 'REVERTED' | 'DROPPED' | 'TAMPERED' | 'PENDING';

async function checkTransaction(
  transaction: Transaction & {
    quote: { calldataHash: string; buyTokenAddress: string } | null;
    wallet: { address: string };
  },
): Promise<Outcome> {
  const client = publicClient(transaction.chainId);
  const hash = transaction.txHash as `0x${string}`;

  const receipt = await client
    .getTransactionReceipt({ hash })
    .catch(() => null);

  if (!receipt) {
    // No receipt yet. Either still pending, or it fell out of the mempool.
    const age = Date.now() - transaction.submittedAt.getTime();

    /**
     * Long enough without inclusion to call it abandoned. This is the
     * transition that releases a custody reservation, which is why it is not
     * the ten-minute one: see ABANDONED_AFTER_MS.
     */
    if (age > ABANDONED_AFTER_MS) {
      await transitionTransaction(
        prisma,
        transaction.id,
        TransactionStatus.FAILED,
        'No receipt after 24 hours. The transaction was never mined and will not be.',
        { failureReason: 'Never mined' },
      );
      await auditTransaction(transaction, AuditAction.TRADE_DROPPED, {});
      return 'DROPPED';
    }

    if (age > DROPPED_AFTER_MS && transaction.status !== TransactionStatus.DROPPED) {
      await transitionTransaction(
        prisma,
        transaction.id,
        TransactionStatus.DROPPED,
        'No receipt after 10 minutes. The transaction may have been dropped from the mempool.',
      );
      await auditTransaction(transaction, AuditAction.TRADE_DROPPED, {});
      return 'DROPPED';
    }
    return 'PENDING';
  }

  // Wait for the transaction to be buried before treating it as final, so a
  // shallow reorg does not turn a "confirmed" trade into a lie.
  const head = await client.getBlockNumber();
  const confirmations = head - receipt.blockNumber + 1n;
  if (confirmations < BigInt(env().WORKER_CONFIRMATIONS)) {
    return 'PENDING';
  }

  const tampered = await verifyCalldata(transaction, hash);

  if (receipt.status === 'reverted') {
    await transitionTransaction(
      prisma,
      transaction.id,
      TransactionStatus.REVERTED,
      'The transaction reverted on-chain. No assets moved, but the network fee was paid.',
      {
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice.toString(),
        networkFeePaid: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
        failureReason: 'Reverted on-chain',
        tamperDetected: tampered,
      },
    );
    await auditTransaction(transaction, AuditAction.TRADE_REVERTED, {
      blockNumber: receipt.blockNumber.toString(),
    });
    return tampered ? 'TAMPERED' : 'REVERTED';
  }

  /**
   * Who the fill landed with. Under custody the swap executes from the
   * omnibus, so the bought tokens arrive there — reading the participant's own
   * wallet would find nothing and the trade would never settle.
   */
  const omnibus = env().CUSTODY_PROVIDER === 'privy' ? env().OMNIBUS_EVM_ADDRESS : undefined;
  const takerAddress = omnibus || transaction.wallet.address;

  const amountOut =
    transaction.kind === TransactionKind.SWAP
      ? extractAmountReceived(
          receipt.logs,
          transaction.quote?.buyTokenAddress ?? transaction.buyTokenAddress,
          takerAddress,
        )
      : null;

  await transitionTransaction(
    prisma,
    transaction.id,
    TransactionStatus.CONFIRMED,
    'Confirmed on-chain.',
    {
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      networkFeePaid: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      amountOutActual: amountOut,
      tamperDetected: tampered,
    },
  );

  await auditTransaction(transaction, AuditAction.TRADE_CONFIRMED, {
    blockNumber: receipt.blockNumber.toString(),
    amountOutActual: amountOut,
  });

  return tampered ? 'TAMPERED' : 'CONFIRMED';
}

/**
 * Verifies that what was mined is what we quoted.
 *
 * The quote persists a hash over (to, data, value). The client is what actually
 * broadcasts, so nothing stops a modified client from signing different
 * calldata and reporting the resulting hash back to us. This is where that is
 * caught: a mismatch means the transaction attributed to a quote is not the
 * transaction that quote described.
 *
 * It is recorded rather than acted on — by the time it is detectable the
 * transaction is already on-chain and nothing can be undone. What it buys is an
 * audit trail and a flag on the record.
 */
async function verifyCalldata(
  transaction: Transaction & { quote: { calldataHash: string } | null },
  hash: `0x${string}`,
): Promise<boolean> {
  if (!transaction.quote) return false;

  try {
    const onChain = await publicClient(transaction.chainId).getTransaction({ hash });
    const actual = calldataHash(
      onChain.to ?? '',
      onChain.input ?? '0x',
      (onChain.value ?? 0n).toString(),
    );

    if (actual === transaction.quote.calldataHash) return false;

    await audit(prisma, {
      action: AuditAction.QUOTE_TAMPERED,
      entityType: 'Transaction',
      entityId: transaction.id,
      actorType: ActorType.SYSTEM,
      actorUserId: transaction.userId,
      after: {
        txHash: transaction.txHash,
        expectedCalldataHash: transaction.quote.calldataHash,
        actualCalldataHash: actual,
        minedTo: onChain.to,
      },
    });

    console.warn('[monitor] calldata mismatch', {
      transactionId: transaction.id,
      txHash: transaction.txHash,
    });

    return true;
  } catch {
    // Unable to check is not the same as a mismatch. Do not flag on a failed
    // read — a false tamper flag on a user's record is its own harm.
    return false;
  }
}

/**
 * Extracts what the taker actually received, from the ERC-20 Transfer logs.
 *
 * The quoted output was an expectation; this is what happened. A native-asset
 * buy produces no Transfer log, so it returns null rather than zero — "we
 * cannot tell from the logs" is not the same as "you received nothing".
 */
export function extractAmountReceived(
  logs: readonly Log[],
  buyTokenAddress: string | null,
  takerAddress: string,
): string | null {
  if (!buyTokenAddress || isNativeToken(buyTokenAddress)) return null;

  let total: bigint | null = null;

  for (const log of logs) {
    if (!addressesEqual(log.address, buyTokenAddress)) continue;

    try {
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (decoded.eventName !== 'Transfer') continue;

      const args = decoded.args as unknown as { to: string; value: bigint };

      // Only transfers landing in the taker's own wallet count. A route moves
      // the token through pools and the router contract first, and summing
      // every Transfer would report several times what the user received.
      if (!addressesEqual(args.to, takerAddress)) continue;

      total = (total ?? 0n) + args.value;
    } catch {
      // Not a Transfer, or a token whose event shape differs. Skip it.
    }
  }

  return total?.toString() ?? null;
}

async function auditTransaction(
  transaction: Transaction,
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  await audit(prisma, {
    action,
    entityType: 'Transaction',
    entityId: transaction.id,
    actorType: ActorType.SYSTEM,
    actorUserId: transaction.userId,
    after: { txHash: transaction.txHash, ...after },
  });
}
