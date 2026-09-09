import {
  LedgerAccountKind,
  LedgerTransferKind,
  Prisma,
  prisma,
  type LedgerAccount,
  type LedgerTransfer,
} from '@flt/db';
import { ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';

/**
 * The custody ledger.
 *
 * FLT holds client assets at a sub-custodian and owes each client a balance.
 * This module is the only thing permitted to move that balance, and it is
 * written to be boring: no convenience helper that posts a one-sided entry, no
 * path that adjusts a balance without recording why, no way to express "just
 * set this to X".
 *
 * ## Double entry, and why it is not optional
 *
 * Every movement has at least two sides that sum to zero. A deposit is a
 * credit to the client and an equal debit against the omnibus account holding
 * their asset; a fee moves value from a client to FLT's revenue account. This
 * is not bookkeeping ceremony — it is what makes "does what we hold match what
 * we owe" a question with an answer. Mt. Gox could not answer it and was
 * drained for years; FTX could not answer it because the accounting permitted a
 * balance nothing backed.
 *
 * ## The database enforces the invariants, not this file
 *
 * A deferred constraint trigger rejects any transfer whose entries do not sum
 * to zero. A CHECK rejects a negative balance on any account not explicitly
 * allowed one. A unique index on (kind, reference) makes a replayed deposit
 * credit exactly once. Those live in the migration deliberately: this service
 * is careful, and the next service somebody writes might not be.
 *
 * ## Balances are a cache
 *
 * `LedgerAccount.balance` is maintained in the same transaction as the entries
 * that move it, because summing every entry on every read does not survive
 * volume. The entries remain the truth, and `recomputeBalance` re-derives from
 * them — which is what the reconciliation job compares against the custodian.
 */

/** One side of a movement. */
export interface EntryInput {
  accountId: string;
  /** Signed: positive increases the account, negative decreases it. */
  amount: Decimal;
}

export interface TransferInput {
  kind: LedgerTransferKind;
  /**
   * The external fact this records — a custodian transaction id, an EVC
   * payment id, a withdrawal id.
   *
   * Strongly preferred over omitting it. With a reference, replaying a webhook
   * or retrying a failed job is safe; without one, the same deposit can be
   * credited twice and nothing will notice until reconciliation.
   */
  reference?: string | null;
  memo: string;
  entries: EntryInput[];
  createdByAdminId?: string | null;
}

/**
 * Posts one balanced movement, atomically.
 *
 * Rejects rather than corrects. A transfer that does not balance is a bug in
 * the caller, and quietly inserting a plug entry to make it balance would hide
 * exactly the defect this ledger exists to surface.
 */
export async function postTransfer(
  input: TransferInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<LedgerTransfer> {
  if (input.entries.length < 2) {
    throw new ValidationError('A ledger transfer needs at least two entries — a movement has two sides');
  }
  if (!input.memo.trim()) {
    throw new ValidationError('A ledger transfer needs a memo explaining why it happened');
  }

  const total = input.entries.reduce((sum, entry) => sum.plus(entry.amount), new Decimal(0));
  if (!total.isZero()) {
    throw new ValidationError(
      `Ledger transfer does not balance: entries sum to ${total.toFixed()}, not zero`,
      { sum: total.toFixed() },
    );
  }
  if (input.entries.some((entry) => entry.amount.isZero())) {
    throw new ValidationError('A zero-amount entry records nothing; omit it instead');
  }

  const run = async (tx: Prisma.TransactionClient) => {
    const transfer = await tx.ledgerTransfer.create({
      data: {
        id: newId(),
        kind: input.kind,
        reference: input.reference ?? null,
        memo: input.memo.trim(),
        createdByAdminId: input.createdByAdminId ?? null,
      },
    });

    for (const entry of input.entries) {
      await tx.ledgerEntry.create({
        data: {
          id: newId(),
          transferId: transfer.id,
          accountId: entry.accountId,
          amount: entry.amount.toFixed(),
        },
      });

      // Updated in the same transaction as the entry, so the cached balance
      // and the entries it summarises can never disagree. The CHECK on the
      // account is what rejects an overdraw — this increment is where it
      // fires.
      await tx.ledgerAccount.update({
        where: { id: entry.accountId },
        data: { balance: { increment: entry.amount.toFixed() } },
      });
    }

    return transfer;
  };

  // Nested transactions are not a thing; when a caller already has one, its
  // atomicity is the one that matters and opening another would break it.
  if (client === prisma) {
    return prisma.$transaction((tx) => run(tx));
  }
  return run(client as Prisma.TransactionClient);
}

/**
 * The account for a client and asset, created on first use.
 *
 * Deliberately not exposed as "create an account": an account exists because
 * value needs somewhere to sit, and letting callers mint accounts freely
 * produces the orphan rows that make reconciliation ambiguous.
 */
export async function accountFor(
  params: { kind: LedgerAccountKind; userId?: string | null; asset: string },
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<LedgerAccount> {
  const asset = params.asset.trim().toUpperCase();
  const userId = params.userId ?? null;

  const isUserAccount =
    params.kind === LedgerAccountKind.USER_AVAILABLE ||
    params.kind === LedgerAccountKind.USER_LOCKED;

  if (isUserAccount && !userId) {
    throw new ValidationError('A client account needs a user');
  }
  if (!isUserAccount && userId) {
    throw new ValidationError('A platform account must not be attached to a user');
  }

  // findFirst rather than findUnique on the composite key: Prisma types a
  // nullable column in a compound unique as non-nullable, and a platform
  // account's userId is legitimately null.
  const existing = await client.ledgerAccount.findFirst({
    where: { kind: params.kind, userId, asset },
  });
  if (existing) return existing;

  return client.ledgerAccount.create({
    data: { id: newId(), kind: params.kind, userId, asset },
  });
}

/** What FLT owes this client in one asset, and what is reserved against it. */
export async function clientBalance(
  userId: string,
  asset: string,
): Promise<{ available: Decimal; locked: Decimal; total: Decimal }> {
  const accounts = await prisma.ledgerAccount.findMany({
    where: {
      userId,
      asset: asset.trim().toUpperCase(),
      kind: { in: [LedgerAccountKind.USER_AVAILABLE, LedgerAccountKind.USER_LOCKED] },
    },
  });

  const of = (kind: LedgerAccountKind) =>
    new Decimal(accounts.find((account) => account.kind === kind)?.balance?.toString() ?? '0');

  const available = of(LedgerAccountKind.USER_AVAILABLE);
  const locked = of(LedgerAccountKind.USER_LOCKED);

  return { available, locked, total: available.plus(locked) };
}

/**
 * Re-derives an account's balance from its entries.
 *
 * The reconciliation job's first question — before it ever asks the custodian
 * anything — is whether the ledger agrees with itself. A cached balance that
 * has drifted from its entries means something wrote to the column outside
 * `postTransfer`, which is a more urgent problem than a custodian mismatch.
 */
export async function recomputeBalance(accountId: string): Promise<Decimal> {
  const result = await prisma.ledgerEntry.aggregate({
    where: { accountId },
    _sum: { amount: true },
  });
  return new Decimal(result._sum.amount?.toString() ?? '0');
}

/**
 * Total client liability in one asset: everything FLT owes, available and
 * locked alike.
 *
 * This is the figure that must be covered by what the custodian actually
 * holds. Locked balances are included because a reserved balance is still
 * owed — a withdrawal in flight is not a balance FLT has stopped owing.
 */
export async function totalClientLiability(asset: string): Promise<Decimal> {
  const result = await prisma.ledgerAccount.aggregate({
    where: {
      asset: asset.trim().toUpperCase(),
      kind: { in: [LedgerAccountKind.USER_AVAILABLE, LedgerAccountKind.USER_LOCKED] },
    },
    _sum: { balance: true },
  });
  return new Decimal(result._sum.balance?.toString() ?? '0');
}

/**
 * Moves a client's balance between available and locked.
 *
 * A lock is a ledger movement like any other, not a flag on a row: the value
 * has to leave the spendable account for "available" to mean what it says.
 * Without this, a client could commit the same balance to two orders and only
 * one of them would be honourable.
 */
export async function lockFunds(params: {
  userId: string;
  asset: string;
  amount: Decimal;
  reference: string;
  memo: string;
}): Promise<LedgerTransfer> {
  return moveBetweenClientAccounts(params, LedgerTransferKind.LOCK, true);
}

export async function unlockFunds(params: {
  userId: string;
  asset: string;
  amount: Decimal;
  reference: string;
  memo: string;
}): Promise<LedgerTransfer> {
  return moveBetweenClientAccounts(params, LedgerTransferKind.UNLOCK, false);
}

async function moveBetweenClientAccounts(
  params: { userId: string; asset: string; amount: Decimal; reference: string; memo: string },
  kind: LedgerTransferKind,
  toLocked: boolean,
): Promise<LedgerTransfer> {
  if (params.amount.lessThanOrEqualTo(0)) {
    throw new ValidationError('Amount must be positive');
  }

  return prisma.$transaction(async (tx) => {
    const available = await accountFor(
      { kind: LedgerAccountKind.USER_AVAILABLE, userId: params.userId, asset: params.asset },
      tx,
    );
    const locked = await accountFor(
      { kind: LedgerAccountKind.USER_LOCKED, userId: params.userId, asset: params.asset },
      tx,
    );

    return postTransfer(
      {
        kind,
        reference: params.reference,
        memo: params.memo,
        entries: [
          { accountId: available.id, amount: toLocked ? params.amount.negated() : params.amount },
          { accountId: locked.id, amount: toLocked ? params.amount : params.amount.negated() },
        ],
      },
      tx,
    );
  });
}
