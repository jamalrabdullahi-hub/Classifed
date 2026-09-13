import {
  AccountStatus,
  AlgorithmStatus,
  CustodyDepositStatus,
  FiatDepositStatus,
  LedgerAccountKind,
  PerpOrderStatus,
  WithdrawalStatus,
  prisma,
  type User,
} from '@flt/db';
import { NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { AuditAction, audit } from './audit';
import { revokeAllSessions } from './sessions';

/**
 * Account deletion.
 *
 * Google Play requires that anyone with an account can ask for it to be
 * deleted. On a custodial exchange that is a request, not an erase:
 *
 *   1. **Request** is refused while FLT still holds anything for the person or
 *      anything of theirs is in motion — each blocker says what to close first.
 *      Otherwise the account is suspended, trading stops and every session ends
 *      at once, so nothing new can start while an operator looks.
 *   2. **Complete** (operator) anonymises the personal details on the account
 *      and identity profile. The ledger, transactions, audit log and KYC
 *      documents are kept: the law requires them, and KYC documents expire on
 *      their own retention clock.
 *   3. **Refuse** (operator) restores the status the account had before.
 */

export type DeletionBlocker =
  | 'balance'
  | 'openOrders'
  | 'openPositions'
  | 'runningAlgorithms'
  | 'depositsInFlight'
  | 'withdrawalsInFlight';

const BLOCKER_MESSAGES: Record<DeletionBlocker, string> = {
  balance: 'Withdraw or spend every balance first, including any amount reserved for an order.',
  openOrders: 'Cancel your open orders first.',
  openPositions: 'Close your open positions first.',
  runningAlgorithms: 'Stop your auto-trading strategies first.',
  depositsInFlight: 'Wait for your pending deposits to finish first.',
  withdrawalsInFlight: 'Wait for your pending withdrawals to finish first.',
};

/** Everything that stops this account from being deleted right now. */
export async function deletionBlockers(userId: string): Promise<DeletionBlocker[]> {
  const [balances, orders, positions, algorithms, custodyDeposits, fiatDeposits, withdrawals, fiatWithdrawals] =
    await Promise.all([
      prisma.ledgerAccount.count({
        where: {
          userId,
          kind: { in: [LedgerAccountKind.USER_AVAILABLE, LedgerAccountKind.USER_LOCKED] },
          balance: { not: 0 },
        },
      }),
      prisma.perpOrder.count({
        where: { userId, status: { in: [PerpOrderStatus.PREPARED, PerpOrderStatus.SUBMITTED] } },
      }),
      prisma.perpPositionSnapshot.count({ where: { userId, size: { notIn: ['0', '0.0', ''] } } }),
      prisma.userAlgorithm.count({
        where: { userId, status: { in: [AlgorithmStatus.ACTIVE, AlgorithmStatus.PAUSED] } },
      }),
      prisma.custodyDeposit.count({
        where: {
          userId,
          status: {
            in: [CustodyDepositStatus.DETECTED, CustodyDepositStatus.SWEEPING, CustodyDepositStatus.SWEPT],
          },
        },
      }),
      prisma.fiatDeposit.count({
        where: {
          userId,
          status: { in: [FiatDepositStatus.AWAITING_FUNDS, FiatDepositStatus.FUNDS_RECEIVED, FiatDepositStatus.SENT] },
        },
      }),
      prisma.withdrawal.count({
        where: {
          userId,
          status: { in: [WithdrawalStatus.PENDING, WithdrawalStatus.BROADCASTING, WithdrawalStatus.SENT] },
        },
      }),
      prisma.fiatWithdrawal.count({ where: { userId, status: 'REQUESTED' } }),
    ]);

  const blockers: DeletionBlocker[] = [];
  if (balances > 0) blockers.push('balance');
  if (orders > 0) blockers.push('openOrders');
  if (positions > 0) blockers.push('openPositions');
  if (algorithms > 0) blockers.push('runningAlgorithms');
  if (custodyDeposits + fiatDeposits > 0) blockers.push('depositsInFlight');
  if (withdrawals + fiatWithdrawals > 0) blockers.push('withdrawalsInFlight');
  return blockers;
}

export async function requestAccountDeletion(user: User) {
  const open = await prisma.accountDeletionRequest.findFirst({
    where: { userId: user.id, status: 'REQUESTED' },
  });
  if (open) return open;

  const blockers = await deletionBlockers(user.id);
  if (blockers.length > 0) {
    throw new ValidationError(blockers.map((b) => BLOCKER_MESSAGES[b]).join(' '), { blockers });
  }

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.accountDeletionRequest.create({
      data: {
        id: newId(),
        userId: user.id,
        previousAccountStatus: user.accountStatus,
        previousTradingDisabled: user.tradingDisabled,
      },
    });
    await tx.user.update({
      where: { id: user.id },
      data: {
        accountStatus: AccountStatus.SUSPENDED,
        tradingDisabled: true,
        suspendedAt: new Date(),
        suspensionReason: 'Account deletion requested by the account holder',
      },
    });
    await revokeAllSessions(tx, user.id);
    return created;
  });

  await audit(prisma, {
    action: AuditAction.ACCOUNT_DELETION_REQUESTED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'account_deletion_request',
    entityId: row.id,
  });

  return row;
}

async function openRequest(requestId: string) {
  const row = await prisma.accountDeletionRequest.findUnique({ where: { id: requestId } });
  if (!row) throw new NotFoundError('Deletion request');
  if (row.status !== 'REQUESTED') {
    throw new ValidationError(`This request is already ${row.status.toLowerCase()}.`);
  }
  return row;
}

/**
 * Anonymises the account. Re-checks the blockers: something may have arrived
 * (a late deposit credit) between the request and the operator's decision.
 */
export async function completeAccountDeletion(adminId: string, requestId: string) {
  const row = await openRequest(requestId);

  const blockers = await deletionBlockers(row.userId);
  if (blockers.length > 0) {
    throw new ValidationError(
      `This account still has: ${blockers.join(', ')}. Resolve that before completing.`,
      { blockers },
    );
  }

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.accountDeletionRequest.updateMany({
      where: { id: row.id, status: 'REQUESTED' },
      data: { status: 'COMPLETED', completedAt: new Date(), completedById: adminId },
    });
    if (claimed.count === 0) throw new ValidationError('Another operator has already handled this request.');

    await tx.user.update({
      where: { id: row.userId },
      data: {
        // Unique and undeliverable, so the address can sign up again.
        email: `deleted-${row.userId}@deleted.invalid`,
        // Not an Argon2 hash, so no password can ever match it.
        passwordHash: 'deleted',
        accountStatus: AccountStatus.SUSPENDED,
        tradingDisabled: true,
        suspensionReason: 'Account deleted',
      },
    });

    await tx.kycProfile.updateMany({
      where: { userId: row.userId },
      data: {
        legalFirstName: null,
        legalLastName: null,
        dateOfBirth: null,
        residenceAddress: null,
        phone: null,
        occupation: null,
        pepDetails: null,
      },
    });

    await revokeAllSessions(tx, row.userId);
  });

  await audit(prisma, {
    action: AuditAction.ACCOUNT_DELETION_COMPLETED,
    actorType: 'ADMIN',
    actorAdminId: adminId,
    entityType: 'account_deletion_request',
    entityId: row.id,
    after: { userId: row.userId },
  });
}

export async function refuseAccountDeletion(adminId: string, requestId: string, input: { note: string }) {
  const note = input.note.trim();
  if (note.length < 8) throw new ValidationError('Say why in at least 8 characters.');
  const row = await openRequest(requestId);

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.accountDeletionRequest.updateMany({
      where: { id: row.id, status: 'REQUESTED' },
      data: { status: 'REFUSED', note, refusedAt: new Date(), refusedById: adminId },
    });
    if (claimed.count === 0) throw new ValidationError('Another operator has already handled this request.');

    await tx.user.update({
      where: { id: row.userId },
      data: {
        accountStatus: row.previousAccountStatus,
        tradingDisabled: row.previousTradingDisabled,
        suspendedAt: row.previousAccountStatus === AccountStatus.SUSPENDED ? undefined : null,
        suspensionReason: row.previousAccountStatus === AccountStatus.SUSPENDED ? undefined : null,
      },
    });
  });

  await audit(prisma, {
    action: AuditAction.ACCOUNT_DELETION_REFUSED,
    actorType: 'ADMIN',
    actorAdminId: adminId,
    entityType: 'account_deletion_request',
    entityId: row.id,
    after: { note },
  });
}

export async function listOpenDeletionRequests() {
  return prisma.accountDeletionRequest.findMany({
    where: { status: 'REQUESTED' },
    include: { user: { select: { email: true } } },
    orderBy: { requestedAt: 'asc' },
    take: 50,
  });
}
