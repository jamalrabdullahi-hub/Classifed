import {
  LedgerAccountKind,
  LedgerTransferKind,
  WithdrawalStatus,
  isUniqueViolation,
  prisma,
  type User,
  type Withdrawal,
} from '@flt/db';
import { NotFoundError, ValidationError } from '../domain/errors';
import { Decimal, fromBaseUnits, toBaseUnits } from '../domain/money';
import { checksumAddress } from '../domain/address';
import { newId } from '../domain/id';
import { accountFor, clientBalance, lockFunds, postTransfer, unlockFunds } from './ledger';
import { assertMayTrade } from './kyc';

/**
 * Withdrawals: taking a custodial balance back out.
 *
 * The last step of the participant loop. A withdrawal is a chain of three
 * facts separated by time — requested, broadcast, confirmed — and each must
 * survive a failure in between:
 *
 *   1. **Request** locks the amount on the ledger (available → locked). Without
 *      the lock the same balance could back a trade and a withdrawal at once.
 *   2. **Send** broadcasts the transfer from the omnibus and records the hash.
 *   3. **Confirm** debits the ledger, only against a mined receipt.
 *
 * The debit happens on confirmation, never on the broadcast: a broadcast can
 * revert or be dropped, and booking money as gone because it was sent would be
 * a lie about the chain. A failure at any point releases the lock rather than
 * stranding the balance.
 */

export interface WithdrawalView {
  id: string;
  asset: string;
  chainId: number;
  amount: string;
  destinationAddress: string;
  txHash: string | null;
  status: WithdrawalStatus;
  failureReason: string | null;
  createdAt: Date;
}

/**
 * Records a withdrawal request and reserves the funds.
 *
 * The lock is taken before the row is written, keyed by the id this function
 * chooses, so a crash between the two leaves a reservation with no withdrawal
 * rather than a withdrawal with no reservation — recoverable, and never a
 * balance promised twice.
 */
export async function requestWithdrawal(
  user: User,
  input: { asset: string; chainId: number; amount: string; destinationAddress: string },
): Promise<Withdrawal> {
  /**
   * The same gate every other money-moving service applies.
   *
   * `quotes.ts`, `perps.ts`, `protection-purchase.ts` and `algorithms.ts` all
   * call this; withdrawal did not, which made suspension cosmetic on the one
   * action that takes funds out of custody. Suspending an account is what an
   * operator does when they believe it is compromised or fraudulent, and it has
   * to stop the withdrawal before it stops the trading.
   */
  assertMayTrade(user);

  const asset = input.asset.trim().toUpperCase();

  const token = await prisma.token.findFirst({
    where: { chainId: input.chainId, symbol: asset, isEnabled: true },
  });
  if (!token) throw new ValidationError('That asset cannot be withdrawn on this chain');

  const destination = checksumAddress(input.destinationAddress);
  const amountBaseUnits = toBaseUnits(input.amount, token.decimals);
  const amount = new Decimal(fromBaseUnits(amountBaseUnits, token.decimals));
  if (amount.lessThanOrEqualTo(0)) {
    throw new ValidationError('Enter an amount greater than zero');
  }

  const balance = await clientBalance(user.id, asset);
  if (balance.available.lessThan(amount)) {
    throw new ValidationError('That is more than your available balance', {
      available: balance.available.toFixed(),
    });
  }

  const id = newId();

  await lockFunds({
    userId: user.id,
    asset,
    amount,
    reference: `withdrawal-lock:${id}`,
    memo: `Reserved ${amount.toFixed()} ${asset} for withdrawal ${id}`,
  });

  try {
    return await prisma.withdrawal.create({
      data: {
        id,
        userId: user.id,
        asset,
        chainId: input.chainId,
        decimals: token.decimals,
        amountBaseUnits,
        destinationAddress: destination,
        status: WithdrawalStatus.PENDING,
      },
    });
  } catch (error) {
    // The reservation has no withdrawal to justify it. Give it back.
    await unlockFunds({
      userId: user.id,
      asset,
      amount,
      reference: `withdrawal-unlock:${id}`,
      memo: `Withdrawal ${id} could not be recorded; releasing the reservation`,
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * Claims a withdrawal for broadcast, before anything is sent.
 *
 * ## Why the status moves first
 *
 * A broadcast has three outcomes, not two: it left, it did not leave, or **we
 * do not know**. The third is the dangerous one — an RPC that accepts the
 * transaction and then times out, or a database write that fails after the
 * transfer is already on the wire. Leaving the row PENDING in that case made
 * the next pass broadcast a second transfer, and the participant was paid
 * twice while the ledger debited once.
 *
 * So the row is moved out of PENDING *before* the send. Anything that goes
 * wrong afterwards leaves it in BROADCASTING, which the worker treats as "find
 * out what happened" rather than "try again".
 *
 * Returns null when the row is not claimable — already claimed, already sent,
 * or gone — so a concurrent pass cannot broadcast the same withdrawal twice.
 */
export async function claimWithdrawalForBroadcast(
  withdrawalId: string,
): Promise<Withdrawal | null> {
  const claimed = await prisma.withdrawal.updateMany({
    where: { id: withdrawalId, status: WithdrawalStatus.PENDING },
    data: {
      status: WithdrawalStatus.BROADCASTING,
      broadcastAt: new Date(),
      broadcastAttempts: { increment: 1 },
    },
  });
  if (claimed.count === 0) return null;
  return prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
}

/**
 * Returns a claimed withdrawal to PENDING, for a broadcast that provably never
 * left.
 *
 * Only safe when the caller has established that no transfer exists — a
 * validation error raised before the send, or an on-chain check that found
 * nothing. Calling this on a genuinely ambiguous failure is what reintroduces
 * the double payment.
 */
export async function releaseWithdrawalClaim(
  withdrawalId: string,
  reason: string,
): Promise<void> {
  await prisma.withdrawal.updateMany({
    where: { id: withdrawalId, status: WithdrawalStatus.BROADCASTING },
    data: { status: WithdrawalStatus.PENDING, failureReason: reason },
  });
}

/** Records that the omnibus transfer was broadcast. */
export async function markWithdrawalSent(
  withdrawalId: string,
  txHash: string,
): Promise<Withdrawal> {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw new NotFoundError('Withdrawal');
  if (
    withdrawal.status !== WithdrawalStatus.PENDING &&
    withdrawal.status !== WithdrawalStatus.BROADCASTING
  ) {
    throw new ValidationError('This withdrawal is not awaiting a transfer', {
      status: withdrawal.status,
    });
  }

  return prisma.withdrawal.update({
    where: { id: withdrawalId },
    data: { status: WithdrawalStatus.SENT, txHash, sentAt: new Date() },
  });
}

/**
 * Debits the ledger once the transfer is confirmed in a mined receipt.
 *
 * The caller is responsible for having checked the receipt — this function
 * trusts that "sent" means "landed" by the time it is called. The debit is
 * idempotent on the withdrawal id, so a retried confirmation does not debit
 * twice.
 */
export async function confirmWithdrawal(
  withdrawalId: string,
): Promise<{ completed: boolean }> {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw new NotFoundError('Withdrawal');
  if (withdrawal.status === WithdrawalStatus.COMPLETED) return { completed: false };
  if (withdrawal.status !== WithdrawalStatus.SENT) {
    throw new ValidationError('This withdrawal has not been sent', { status: withdrawal.status });
  }
  if (!withdrawal.txHash) {
    throw new ValidationError('This withdrawal has no transaction hash to confirm');
  }

  const amount = new Decimal(fromBaseUnits(withdrawal.amountBaseUnits, withdrawal.decimals));

  try {
    await prisma.$transaction(async (tx) => {
      const locked = await accountFor(
        { kind: LedgerAccountKind.USER_LOCKED, userId: withdrawal.userId, asset: withdrawal.asset },
        tx,
      );
      const omnibus = await accountFor(
        { kind: LedgerAccountKind.CLIENT_OMNIBUS, asset: withdrawal.asset },
        tx,
      );

      /**
       * The reservation is spent and the omnibus holds that much less — the
       * value has left custody for the destination address.
       */
      await postTransfer(
        {
          kind: LedgerTransferKind.WITHDRAWAL,
          reference: `withdrawal:${withdrawal.id}`,
          memo: `Withdrawal ${withdrawal.id} sent to ${withdrawal.destinationAddress} (${withdrawal.txHash})`,
          entries: [
            { accountId: locked.id, amount },
            { accountId: omnibus.id, amount: amount.negated() },
          ],
        },
        tx,
      );

      await tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: WithdrawalStatus.COMPLETED, completedAt: new Date() },
      });
    });

    return { completed: true };
  } catch (error) {
    if (isUniqueViolation(error)) return { completed: false };
    throw error;
  }
}

/**
 * Marks a withdrawal failed and releases the reservation.
 *
 * Used when the broadcast reverts, is dropped, or cannot be sent at all. The
 * funds go back to available — a withdrawal that did not happen must not leave
 * the balance frozen.
 */
export async function failWithdrawal(
  withdrawalId: string,
  reason: string,
): Promise<Withdrawal> {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw new NotFoundError('Withdrawal');
  if (
    withdrawal.status === WithdrawalStatus.COMPLETED ||
    withdrawal.status === WithdrawalStatus.FAILED
  ) {
    return withdrawal;
  }

  const amount = new Decimal(fromBaseUnits(withdrawal.amountBaseUnits, withdrawal.decimals));

  await unlockFunds({
    userId: withdrawal.userId,
    asset: withdrawal.asset,
    amount,
    reference: `withdrawal-unlock:${withdrawal.id}`,
    memo: `Withdrawal ${withdrawal.id} did not complete; releasing the reservation`,
  });

  return prisma.withdrawal.update({
    where: { id: withdrawal.id },
    data: { status: WithdrawalStatus.FAILED, failureReason: reason },
  });
}

export async function listWithdrawalsForUser(userId: string): Promise<WithdrawalView[]> {
  const rows = await prisma.withdrawal.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });

  return rows.map((row) => ({
    id: row.id,
    asset: row.asset,
    chainId: row.chainId,
    amount: fromBaseUnits(row.amountBaseUnits, row.decimals),
    destinationAddress: row.destinationAddress,
    txHash: row.txHash,
    status: row.status,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
  }));
}
