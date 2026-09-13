import {
  ReferralEarningKind,
  ActorType,
  QuoteStatus,
  TransactionKind,
  TransactionStatus,
  type DbClient,
  type Transaction,
  type User,
  isUniqueViolation,
  prisma,
} from '@flt/db';
import {
  ConflictError,
  NotFoundError,
  QuoteAlreadyUsedError,
  ValidationError,
} from '../domain/errors';
import { newId } from '../domain/id';
import { recordReferralEarning } from './referrals';
import { assertTxHash, checksumAddress } from '../domain/address';
import { transactionStateMachine } from '../domain/state';
import { AuditAction, audit } from './audit';
import { loadActiveQuote } from './quotes';
import { getWallet } from './wallets';
import { settleCustodyTradeAfterConfirm, releaseCustodyTradeLock } from './custody-trades';

/**
 * Trade submission.
 *
 * The user's wallet broadcasts the transaction, not us — so by the time this
 * runs, the transaction may already be in the mempool. This service records
 * what was signed and hands it to the monitor; it cannot cancel, replace or
 * accelerate anything, and it does not pretend to.
 *
 * Consuming the quote is the important part. A quote is single-use, and the
 * update is conditional on it still being ACTIVE, so two submissions racing on
 * the same quote produce one record and one clear error rather than two trades.
 */

export interface SubmitTradeInput {
  user: User;
  quoteId: string;
  txHash: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

export async function submitTrade(input: SubmitTradeInput): Promise<Transaction> {
  const quote = await loadActiveQuote(input.quoteId, input.user.id);
  const txHash = assertTxHash(input.txHash);
  const wallet = await getWallet(prisma, input.user.id, quote.walletId);

  try {
    const transaction = await prisma.$transaction(async (tx) => {
      // Conditional on ACTIVE: whoever wins this update owns the quote.
      const consumed = await tx.quote.updateMany({
        where: { id: quote.id, status: QuoteStatus.ACTIVE },
        data: { status: QuoteStatus.CONSUMED, consumedAt: new Date() },
      });
      if (consumed.count !== 1) {
        throw new QuoteAlreadyUsedError(quote.id);
      }

      const created = await tx.transaction.create({
        data: {
          id: newId(),
          userId: input.user.id,
          walletId: wallet.id,
          quoteId: quote.id,
          chainId: quote.chainId,
          kind: TransactionKind.SWAP,
          txHash,
          status: TransactionStatus.SUBMITTED,
          sellTokenAddress: quote.sellTokenAddress,
          buyTokenAddress: quote.buyTokenAddress,
        },
      });

      await tx.transactionEvent.create({
        data: {
          id: newId(),
          transactionId: created.id,
          status: TransactionStatus.SUBMITTED,
          detail: 'Signed in wallet and broadcast to the network',
        },
      });

      return created;
    });

    await audit(prisma, {
      action: AuditAction.TRADE_SUBMITTED,
      entityType: 'Transaction',
      entityId: transaction.id,
      actorType: ActorType.USER,
      actorUserId: input.user.id,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      after: {
        txHash,
        quoteId: quote.id,
        chainId: quote.chainId,
        sellAmount: quote.sellAmount,
        expectedBuyAmount: quote.buyAmount,
        minBuyAmount: quote.minBuyAmount,
      },
    });

    return transaction;
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The same hash on the same chain is the same transaction. Return the
      // existing record rather than failing a retry the user cannot distinguish
      // from a first attempt.
      const existing = await prisma.transaction.findUnique({
        where: { chainId_txHash: { chainId: quote.chainId, txHash } },
      });
      if (existing && existing.userId === input.user.id) return existing;
      throw new ConflictError('TRANSACTION_EXISTS', 'That transaction is already recorded.');
    }
    throw error;
  }
}

/**
 * Records an ERC-20 approval.
 *
 * Tracked as its own transaction so the Activity feed explains the two wallet
 * prompts a first-time trade requires. Not tied to a quote: an approval outlives
 * the quote that prompted it.
 */
export async function recordApproval(
  input: {
    user: User;
    walletId: string;
    chainId: number;
    txHash: string;
    tokenAddress: string;
    spenderAddress: string;
    ip?: string | null;
    userAgent?: string | null;
    requestId?: string;
  },
): Promise<Transaction> {
  const wallet = await getWallet(prisma, input.user.id, input.walletId);
  const txHash = assertTxHash(input.txHash);

  try {
    const transaction = await prisma.$transaction(async (tx) => {
      const created = await tx.transaction.create({
        data: {
          id: newId(),
          userId: input.user.id,
          walletId: wallet.id,
          chainId: input.chainId,
          kind: TransactionKind.APPROVAL,
          txHash,
          status: TransactionStatus.SUBMITTED,
          sellTokenAddress: checksumAddress(input.tokenAddress),
        },
      });

      await tx.transactionEvent.create({
        data: {
          id: newId(),
          transactionId: created.id,
          status: TransactionStatus.SUBMITTED,
          detail: `Approval broadcast for ${checksumAddress(input.spenderAddress)}`,
        },
      });

      return created;
    });

    await audit(prisma, {
      action: AuditAction.APPROVAL_SUBMITTED,
      entityType: 'Transaction',
      entityId: transaction.id,
      actorType: ActorType.USER,
      actorUserId: input.user.id,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      after: {
        txHash,
        token: checksumAddress(input.tokenAddress),
        spender: checksumAddress(input.spenderAddress),
      },
    });

    return transaction;
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await prisma.transaction.findUnique({
        where: { chainId_txHash: { chainId: input.chainId, txHash } },
      });
      if (existing && existing.userId === input.user.id) return existing;
    }
    throw error;
  }
}

/**
 * Moves a transaction to a new status, enforcing the lifecycle.
 *
 * Every change writes an event row, so the Activity timeline is derived from
 * history rather than reconstructed from the current status.
 */
export async function transitionTransaction(
  db: DbClient,
  transactionId: string,
  next: TransactionStatus,
  detail: string,
  extra: {
    blockNumber?: bigint | null;
    gasUsed?: string | null;
    effectiveGasPrice?: string | null;
    networkFeePaid?: string | null;
    amountInActual?: string | null;
    amountOutActual?: string | null;
    failureReason?: string | null;
    tamperDetected?: boolean;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const current = await db.transaction.findUnique({ where: { id: transactionId } });
  if (!current) throw new NotFoundError('Transaction');

  if (current.status === next) return;
  transactionStateMachine.assertTransition(current.status, next);

  await db.transaction.update({
    where: { id: transactionId },
    data: {
      status: next,
      blockNumber: extra.blockNumber ?? current.blockNumber,
      gasUsed: extra.gasUsed ?? current.gasUsed,
      effectiveGasPrice: extra.effectiveGasPrice ?? current.effectiveGasPrice,
      networkFeePaid: extra.networkFeePaid ?? current.networkFeePaid,
      amountInActual: extra.amountInActual ?? current.amountInActual,
      amountOutActual: extra.amountOutActual ?? current.amountOutActual,
      failureReason: extra.failureReason ?? current.failureReason,
      tamperDetected: extra.tamperDetected ?? current.tamperDetected,
      confirmedAt: next === TransactionStatus.CONFIRMED ? new Date() : current.confirmedAt,
    },
  });

  await db.transactionEvent.create({
    data: {
      id: newId(),
      transactionId,
      status: next,
      detail,
      blockNumber: extra.blockNumber ?? null,
      metadata: (extra.metadata ?? undefined) as never,
    },
  });

  /**
   * The referrer's share of the trading fee, once the trade has actually landed.
   *
   * On confirmation and nowhere earlier: a submitted trade can revert, and a
   * share of a fee that was never collected is a liability against revenue that
   * does not exist.
   *
   * Denominated in the fee's own token rather than converted to dollars. The
   * fee was taken in that token, the price at the moment of the fill is not
   * stored, and a converted figure would be an estimate presented as an amount
   * owed.
   */
  if (next === TransactionStatus.CONFIRMED && current.quoteId) {
    const quote = await db.quote.findUnique({
      where: { id: current.quoteId },
      select: { id: true, feeAmount: true, feeTokenAddress: true, chainId: true },
    });

    if (quote?.feeAmount && quote.feeTokenAddress) {
      await recordReferralEarning(db, {
        userId: current.userId,
        kind: ReferralEarningKind.TRADING_FEE,
        grossAmount: quote.feeAmount,
        tokenAddress: quote.feeTokenAddress,
        chainId: quote.chainId,
        quoteId: quote.id,
      });
    }
  }

  /**
   * Custody settlement, once the swap is confirmed. No-ops unless custody is
   * on, so the pre-custody confirmed path is unchanged. The amount is the one
   * the monitor read off the mined receipt — see
   * `settleCustodyTradeAfterConfirm` for why it is not the quote's promise.
   */
  if (
    next === TransactionStatus.CONFIRMED &&
    current.quoteId &&
    current.kind === TransactionKind.SWAP
  ) {
    await settleCustodyTradeAfterConfirm(db, {
      transactionId,
      userId: current.userId,
      quoteId: current.quoteId,
      receivedBaseUnits: extra.amountOutActual ?? null,
    });
  }

  /**
   * A swap that can never land moved nothing, so the reservation taken at
   * execute is given back. No-ops unless custody is on.
   *
   * ## Why DROPPED does not release
   *
   * DROPPED means "no receipt yet and it has been a while" — not "gone".
   * `DROPPED -> CONFIRMED` is a legal transition and the monitor keeps polling
   * dropped transactions, because a congested transaction routinely mines after
   * the ten-minute mark. Releasing there and settling later spent the same
   * reservation twice: the funds went back to spendable, the swap then
   * confirmed, and settlement tried to debit a `USER_LOCKED` balance that was no
   * longer there. The participant kept money the omnibus had already paid out.
   *
   * So only the two genuinely terminal outcomes release: REVERTED (mined and
   * failed, so nothing moved) and FAILED (the monitor has concluded the
   * transaction can never be mined).
   */
  if (
    (next === TransactionStatus.REVERTED || next === TransactionStatus.FAILED) &&
    current.quoteId &&
    current.kind === TransactionKind.SWAP
  ) {
    await releaseCustodyTradeLock(db, {
      transactionId,
      userId: current.userId,
      quoteId: current.quoteId,
    });
  }
}

export async function listTransactions(
  db: DbClient,
  userId: string,
  options: { limit?: number; cursor?: string; walletId?: string } = {},
) {
  return db.transaction.findMany({
    where: { userId, ...(options.walletId ? { walletId: options.walletId } : {}) },
    include: { events: { orderBy: { occurredAt: 'asc' } }, wallet: true },
    orderBy: { submittedAt: 'desc' },
    take: Math.min(options.limit ?? 25, 100),
    ...(options.cursor ? { skip: 1, cursor: { id: options.cursor } } : {}),
  });
}

export async function getTransaction(db: DbClient, userId: string, transactionId: string) {
  const transaction = await db.transaction.findFirst({
    where: { id: transactionId, userId },
    include: { events: { orderBy: { occurredAt: 'asc' } }, quote: true, wallet: true },
  });
  if (!transaction) throw new NotFoundError('Transaction');
  return transaction;
}

/** Guard for the submit endpoint: the hash must be well-formed before we store it. */
export function assertSubmittable(txHash: string): void {
  try {
    assertTxHash(txHash);
  } catch {
    throw new ValidationError('That is not a valid transaction hash');
  }
}
