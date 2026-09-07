import {
  PassiveCashEntryKind,
  prisma,
  type PassiveCashAccount,
  type PassiveCashEntry,
  type User,
} from '@flt/db';
import { env } from '@flt/config';
import { NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { AuditAction, audit } from './audit';

/**
 * Passive cash: idle balances used in FLT's market-making, for half the profit.
 *
 * ## This is not like the rest of the platform, and the code says so
 *
 * Everywhere else, FLT holds nothing. Here it holds the participant's money and
 * trades with it. That is custody and a managed investment, and in most
 * jurisdictions a pooled version of it is a collective investment scheme with
 * its own authorisation regime — separate from any exchange licence.
 *
 * It is modelled in its own tables for that reason. No trading balance shares a
 * row with it and no code path treats the two as the same kind of thing,
 * because the day somebody has to answer "which of these is client money" the
 * answer needs to be a query rather than an argument.
 *
 * ## The asymmetry, stated rather than buried
 *
 * Profit is split. Loss is not: the participant bears losses against their own
 * capital, because the alternative is FLT guaranteeing a principal it has no
 * mechanism to guarantee. Both shares are columns on the account, so what was
 * agreed is recorded rather than assumed — and the disclosure has to be
 * accepted, by version, before the account can be switched on.
 *
 * ## Withdrawable on demand
 *
 * The balance is the participant's. Capital committed to a live quote cannot be
 * pulled mid-trade, but nothing here locks it up: a withdrawal reduces the
 * amount available to the book from the next cycle.
 */

/**
 * The disclosure text, versioned.
 *
 * Bumping the version forces every participant to accept again. That is the
 * point — terms that changed silently were never agreed to.
 */
export const DISCLOSURE_VERSION = '2026-09-07.1';

export const DISCLOSURE_POINTS = [
  'FLT takes custody of this money. Unlike your trading balance, which never leaves your wallet, this is transferred to FLT and held by FLT.',
  'It is used for market-making — quoting both sides of a market to earn the spread. That is trading, and trading loses money as well as making it.',
  'You keep half of any profit. You bear all of any loss against the money you put in. There is no guarantee of your capital and no guarantee of a return.',
  'Past or modelled returns are not a forecast. The figures shown elsewhere on this platform are models built on assumptions that may be wrong.',
  'You can switch this off and withdraw at any time. Money already committed to a live quote is returned when that position closes, not instantly.',
  'FLT is not acting as your investment adviser and this is not advice. If you cannot afford to lose this money, do not contribute it.',
] as const;

export interface PassiveCashSummary {
  account: PassiveCashAccount | null;
  isEnabled: boolean;
  balance: string;
  lifetimeEarned: string;
  lifetimeLost: string;
  profitSharePct: number;
  lossSharePct: number;
  /** True when the accepted disclosure is older than the current one. */
  needsReacceptance: boolean;
  disclosureVersion: string;
  disclosurePoints: readonly string[];
  /**
   * Whether contributed money could do anything right now.
   *
   * False while the market maker has no execution — and a participant must not
   * be able to hand over money to a book that cannot trade it.
   */
  operational: boolean;
  recentEntries: PassiveCashEntry[];
}

/**
 * Whether the programme can accept money at all.
 *
 * The market maker has no execution path: it computes quotes and nothing in the
 * platform can place them. Taking contributions for a book that cannot trade
 * would be taking money for a service that does not run, so the whole feature
 * refuses until an operator turns it on deliberately — and turning it on
 * requires the execution that does not exist yet.
 */
export function passiveCashOperational(): boolean {
  return env().PASSIVE_CASH_ENABLED;
}

export async function passiveCashSummary(userId: string): Promise<PassiveCashSummary> {
  const account = await prisma.passiveCashAccount.findUnique({ where: { userId } });

  const recentEntries = account
    ? await prisma.passiveCashEntry.findMany({
        where: { accountId: account.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
    : [];

  return {
    account,
    isEnabled: account?.isEnabled ?? false,
    balance: account?.balance ?? '0',
    lifetimeEarned: account?.lifetimeEarned ?? '0',
    lifetimeLost: account?.lifetimeLost ?? '0',
    profitSharePct: (account?.profitShareBps ?? 5_000) / 100,
    lossSharePct: (account?.lossShareBps ?? 10_000) / 100,
    needsReacceptance:
      account !== null && account.disclosureVersion !== DISCLOSURE_VERSION,
    disclosureVersion: DISCLOSURE_VERSION,
    disclosurePoints: DISCLOSURE_POINTS,
    operational: passiveCashOperational(),
    recentEntries,
  };
}

/**
 * Switches the account on, against an accepted disclosure.
 *
 * The version is checked rather than a boolean: a participant who accepted an
 * older wording has not agreed to the current one, and pretending otherwise is
 * the kind of thing that only matters once.
 */
export async function enablePassiveCash(
  user: User,
  acceptedVersion: string,
): Promise<PassiveCashAccount> {
  if (!passiveCashOperational()) {
    throw new ValidationError(
      'Passive cash is not accepting contributions on this deployment. The market-making book ' +
        'has no execution, so contributed money could not be put to work.',
    );
  }

  if (acceptedVersion !== DISCLOSURE_VERSION) {
    throw new ValidationError(
      'The disclosure has changed since you last read it. Please read and accept the current one.',
      { expected: DISCLOSURE_VERSION, accepted: acceptedVersion },
    );
  }

  const now = new Date();

  const account = await prisma.passiveCashAccount.upsert({
    where: { userId: user.id },
    create: {
      id: newId(),
      userId: user.id,
      isEnabled: true,
      disclosureVersion: DISCLOSURE_VERSION,
      disclosureAcceptedAt: now,
      enabledAt: now,
    },
    update: {
      isEnabled: true,
      disclosureVersion: DISCLOSURE_VERSION,
      disclosureAcceptedAt: now,
      enabledAt: now,
      disabledAt: null,
    },
  });

  await audit(prisma, {
    action: AuditAction.PASSIVE_CASH_ENABLED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'passive_cash_account',
    entityId: account.id,
    after: { disclosureVersion: DISCLOSURE_VERSION, acceptedAt: now },
  });

  return account;
}

/**
 * Switches it off. The balance stays and stays withdrawable — turning the
 * programme off is not a forfeiture.
 */
export async function disablePassiveCash(user: User): Promise<PassiveCashAccount> {
  const account = await prisma.passiveCashAccount.findUnique({ where: { userId: user.id } });
  if (!account) throw new NotFoundError('Passive cash account');

  const updated = await prisma.passiveCashAccount.update({
    where: { id: account.id },
    data: { isEnabled: false, disabledAt: new Date() },
  });

  await audit(prisma, {
    action: AuditAction.PASSIVE_CASH_DISABLED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'passive_cash_account',
    entityId: account.id,
  });

  return updated;
}

/**
 * Records a movement and the balance it produces, in one transaction.
 *
 * The balance is never written on its own. It is the running total of the
 * entries, and `balanceAfter` on each row means a statement reconciles line by
 * line — a balance that cannot be reconciled against its own history is a
 * number somebody has to take on trust, which is exactly what this programme
 * cannot afford.
 */
export async function recordPassiveCashEntry(
  userId: string,
  input: {
    kind: PassiveCashEntryKind;
    /** Always positive; `kind` carries the direction. */
    amount: string;
    grossAmount?: string | null;
    shareBps?: number | null;
    reason?: string | null;
    txHash?: string | null;
  },
): Promise<PassiveCashEntry> {
  const amount = new Decimal(input.amount);
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    throw new ValidationError('Amount must be positive', { amount: input.amount });
  }

  return prisma.$transaction(async (tx) => {
    const account = await tx.passiveCashAccount.findUnique({ where: { userId } });
    if (!account) throw new NotFoundError('Passive cash account');

    const current = new Decimal(account.balance);

    const adds =
      input.kind === PassiveCashEntryKind.CONTRIBUTION ||
      input.kind === PassiveCashEntryKind.PROFIT_SHARE;

    const next = adds ? current.plus(amount) : current.minus(amount);

    if (next.isNegative()) {
      throw new ValidationError('That would take the balance below zero', {
        balance: account.balance,
        amount: input.amount,
      });
    }

    const entry = await tx.passiveCashEntry.create({
      data: {
        id: newId(),
        accountId: account.id,
        kind: input.kind,
        amount: amount.toFixed(),
        balanceAfter: next.toFixed(),
        grossAmount: input.grossAmount ?? null,
        shareBps: input.shareBps ?? null,
        reason: input.reason ?? null,
        txHash: input.txHash ?? null,
      },
    });

    await tx.passiveCashAccount.update({
      where: { id: account.id },
      data: {
        balance: next.toFixed(),
        // Earned and lost are tracked separately and never netted: one figure
        // would hide which of the two actually happened.
        ...(input.kind === PassiveCashEntryKind.PROFIT_SHARE
          ? { lifetimeEarned: new Decimal(account.lifetimeEarned).plus(amount).toFixed() }
          : {}),
        ...(input.kind === PassiveCashEntryKind.LOSS
          ? { lifetimeLost: new Decimal(account.lifetimeLost).plus(amount).toFixed() }
          : {}),
      },
    });

    return entry;
  });
}

/**
 * Splits one period's trading result across the participants.
 *
 * Profit is shared at each account's agreed rate; loss is applied at its own,
 * which is not the same number. Written per account rather than as one pooled
 * figure so every participant's entry names the gross it came from.
 */
export async function distributeResult(params: {
  /** Signed. Positive is profit. */
  netResult: string;
  reason: string;
}): Promise<{ accounts: number; distributed: string }> {
  const net = new Decimal(params.netResult);
  if (!net.isFinite()) throw new ValidationError('Result must be a finite number');

  const accounts = await prisma.passiveCashAccount.findMany({
    where: { isEnabled: true, balance: { not: '0' } },
  });

  const totalCapital = accounts.reduce(
    (sum, account) => sum.plus(account.balance),
    new Decimal(0),
  );

  if (totalCapital.lessThanOrEqualTo(0)) {
    return { accounts: 0, distributed: '0' };
  }

  let distributed = new Decimal(0);

  for (const account of accounts) {
    // Pro rata by contributed capital, so a bigger contribution takes a
    // proportionally bigger share of both outcomes.
    const weight = new Decimal(account.balance).dividedBy(totalCapital);
    const gross = net.times(weight);

    const shareBps = net.isPositive() ? account.profitShareBps : account.lossShareBps;
    const amount = gross.times(shareBps).dividedBy(10_000).abs();

    if (amount.lessThanOrEqualTo(0)) continue;

    await recordPassiveCashEntry(account.userId, {
      kind: net.isPositive()
        ? PassiveCashEntryKind.PROFIT_SHARE
        : PassiveCashEntryKind.LOSS,
      amount: amount.toFixed(),
      grossAmount: gross.abs().toFixed(),
      shareBps,
      reason: params.reason,
    });

    distributed = distributed.plus(amount);
  }

  return { accounts: accounts.length, distributed: distributed.toFixed() };
}
