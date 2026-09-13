import { randomBytes } from 'node:crypto';
import {
  LedgerAccountKind,
  LedgerTransferKind,
  isUniqueViolation,
  prisma,
  type User,
} from '@flt/db';
import { NotFoundError, ValidationError } from '../domain/errors';
import { Decimal } from '../domain/money';
import { newId } from '../domain/id';
import { accountFor, clientBalance, lockFunds, postTransfer, unlockFunds } from './ledger';
import { assertMayTrade } from './kyc';
import { AuditAction, audit } from './audit';
import { resolveFiatRailSettings } from './platform-settings';

/**
 * Cash withdrawals: a custodial USD balance paid out by an operator.
 *
 * ## The shape
 *
 * A participant asks for dollars to be sent to an EVC number, a bank account or
 * a PayPal address. FLT pays that out of its own accounts, and the participant's
 * USDC — which stays in the omnibus — becomes FLT's.
 *
 *   1. **Request** reserves the amount on the ledger (available → locked), so
 *      the same balance cannot back a trade and a payout at once.
 *   2. **Paid** is an operator recording the payout with the bank, EVC or
 *      PayPal reference. Only then is the reservation spent: the locked balance
 *      is consumed, the net becomes FLT's own capital, and the fee is revenue.
 *   3. **Rejected** releases the reservation, and only before any payout.
 *
 * ## Why the USDC does not move
 *
 * FLT paid the person in cash from its own bank. The stablecoin that backed
 * their balance is still in the omnibus, now owned by FLT rather than owed to
 * a client. So the ledger moves value from the participant's liability to
 * PLATFORM_EQUITY and FEE_REVENUE — both FLT's own — and the omnibus is
 * untouched. Reconciliation then sees client liabilities fall with the omnibus
 * unchanged, which is a surplus it expects, never a shortfall.
 *
 * ## What it will not do
 *
 * Pay a card. Card payouts need a processor; there is no manual equivalent.
 */

const ASSET = 'USDC';
const MAX_OPEN = 3;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FiatWithdrawalMethodName = 'EVC' | 'BANK' | 'PAYPAL';

export interface FiatWithdrawalInput {
  method: FiatWithdrawalMethodName;
  amountUsd: string;
  payeeName: string;
  payeePhone?: string;
  payeeEmail?: string;
  bankName?: string;
  accountNumber?: string;
  routingNumber?: string;
  swift?: string;
  country?: string;
}

function newReference(): string {
  return `W-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function required(value: string | undefined | null, min: number, message: string): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length < min) throw new ValidationError(message);
  return trimmed;
}

export async function requestFiatWithdrawal(user: User, input: FiatWithdrawalInput) {
  // The gate every money-moving service applies. A suspended account must not
  // be able to take cash out while its trading is stopped.
  assertMayTrade(user);

  const settings = (await resolveFiatRailSettings()).withdrawals;
  if (!settings.enabled) {
    throw new ValidationError('Cash withdrawals are not open yet.');
  }
  const methodOpen = { EVC: settings.evc, BANK: settings.bank, PAYPAL: settings.paypal }[input.method];
  if (!methodOpen) {
    throw new ValidationError('That payout method is not available right now.');
  }

  const amount = new Decimal(input.amountUsd).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    throw new ValidationError('Enter how much to withdraw.');
  }
  const minimum = new Decimal(settings.minUsd);
  if (amount.lessThan(minimum)) {
    throw new ValidationError(`The minimum cash withdrawal is $${minimum.toFixed(2)}.`);
  }

  // Rounded up to the cent, so the fee is never a fraction FLT cannot collect.
  const fee = amount.times(settings.feeBps).dividedBy(10_000).toDecimalPlaces(2, Decimal.ROUND_UP);
  const net = amount.minus(fee);
  if (net.lessThanOrEqualTo(0)) {
    throw new ValidationError('That amount does not cover the withdrawal fee.');
  }

  const destination = {
    payeeName: required(input.payeeName, 2, 'Give the name on the receiving account.'),
    payeePhone: null as string | null,
    payeeEmail: null as string | null,
    bankName: null as string | null,
    accountNumber: null as string | null,
    routingNumber: null as string | null,
    swift: null as string | null,
    country: null as string | null,
  };

  if (input.method === 'EVC') {
    const phone = (input.payeePhone ?? '').replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 7) {
      throw new ValidationError('Give the EVC number to pay.');
    }
    destination.payeePhone = phone;
  } else if (input.method === 'BANK') {
    destination.bankName = required(input.bankName, 2, 'Give the name of the receiving bank.');
    const account = (input.accountNumber ?? '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z0-9]{4,40}$/.test(account)) {
      throw new ValidationError('Give the account number or IBAN.');
    }
    destination.accountNumber = account;
    destination.routingNumber = (input.routingNumber ?? '').trim() || null;
    const swift = (input.swift ?? '').replace(/\s+/g, '').toUpperCase();
    if (swift && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(swift)) {
      throw new ValidationError('That SWIFT/BIC code is not valid.');
    }
    destination.swift = swift || null;
    destination.country = (input.country ?? '').trim() || null;
  } else {
    const email = (input.payeeEmail ?? '').trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      throw new ValidationError('Give the PayPal email address to pay.');
    }
    destination.payeeEmail = email;
  }

  const open = await prisma.fiatWithdrawal.count({
    where: { userId: user.id, status: 'REQUESTED' },
  });
  if (open >= MAX_OPEN) {
    throw new ValidationError('You already have cash withdrawals waiting. They will be paid shortly.');
  }

  const balance = await clientBalance(user.id, ASSET);
  if (balance.available.lessThan(amount)) {
    throw new ValidationError('That is more than your available balance.', {
      available: balance.available.toFixed(2),
    });
  }

  const id = newId();

  // Reserved before the row exists, keyed by the id chosen here, so a crash in
  // between leaves a reservation with no request rather than a request with no
  // reservation — recoverable, and never a balance promised twice.
  await lockFunds({
    userId: user.id,
    asset: ASSET,
    amount,
    reference: `fiat-withdrawal-lock:${id}`,
    memo: `Reserved ${amount.toFixed(2)} ${ASSET} for cash withdrawal ${id}`,
  });

  try {
    const row = await prisma.fiatWithdrawal.create({
      data: {
        id,
        userId: user.id,
        method: input.method,
        asset: ASSET,
        amountUsd: amount.toFixed(2),
        feeUsd: fee.toFixed(2),
        netUsd: net.toFixed(2),
        ...destination,
        reference: newReference(),
      },
    });

    await audit(prisma, {
      action: AuditAction.FIAT_WITHDRAWAL_REQUESTED,
      actorType: 'USER',
      actorUserId: user.id,
      entityType: 'fiat_withdrawal',
      entityId: id,
      after: { method: input.method, amountUsd: amount.toFixed(2), feeUsd: fee.toFixed(2) },
    });

    return row;
  } catch (error) {
    await unlockFunds({
      userId: user.id,
      asset: ASSET,
      amount,
      reference: `fiat-withdrawal-unlock:${id}`,
      memo: `Cash withdrawal ${id} could not be recorded; releasing the reservation`,
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * Records a payout and spends the reservation.
 *
 * The status change and the ledger movement are one transaction, and the status
 * change is a guarded claim (REQUESTED → PAID), so two operators confirming the
 * same payout cannot both post it. The reference is required: a payout recorded
 * with nothing to check it against is indistinguishable from a mistake.
 */
export async function markFiatWithdrawalPaid(
  adminId: string,
  withdrawalId: string,
  input: { payoutReference: string; note?: string | null },
) {
  const payoutReference = required(
    input.payoutReference,
    3,
    'Record the payout reference from the bank, EVC or PayPal.',
  );

  const row = await prisma.fiatWithdrawal.findUnique({ where: { id: withdrawalId } });
  if (!row) throw new NotFoundError('Withdrawal');
  if (row.status !== 'REQUESTED') {
    throw new ValidationError(`This withdrawal is already ${row.status.toLowerCase()}.`);
  }

  const gross = new Decimal(row.amountUsd.toString());
  const fee = new Decimal(row.feeUsd.toString());
  const net = new Decimal(row.netUsd.toString());

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.fiatWithdrawal.updateMany({
      where: { id: row.id, status: 'REQUESTED' },
      data: {
        status: 'PAID',
        payoutReference,
        note: input.note?.trim() || null,
        paidAt: new Date(),
        paidById: adminId,
      },
    });
    if (claimed.count === 0) {
      throw new ValidationError('Another operator has already handled this withdrawal.');
    }

    const locked = await accountFor(
      { kind: LedgerAccountKind.USER_LOCKED, userId: row.userId, asset: row.asset },
      tx,
    );
    const equity = await accountFor({ kind: LedgerAccountKind.PLATFORM_EQUITY, asset: row.asset }, tx);
    const revenue = await accountFor({ kind: LedgerAccountKind.FEE_REVENUE, asset: row.asset }, tx);

    /**
     * The reservation is spent. The net becomes FLT's own capital — it paid
     * the person in cash and keeps the stablecoin — and the fee is revenue.
     * gross − net − fee = 0, and every account keeps its sign.
     */
    await postTransfer(
      {
        kind: LedgerTransferKind.WITHDRAWAL,
        reference: `fiat-withdrawal:${row.id}`,
        memo: `Cash withdrawal ${row.reference} paid by ${row.method} (${payoutReference})`,
        createdByAdminId: adminId,
        entries: [
          { accountId: locked.id, amount: gross },
          { accountId: equity.id, amount: net.negated() },
          ...(fee.isZero() ? [] : [{ accountId: revenue.id, amount: fee.negated() }]),
        ],
      },
      tx,
    );
  });

  await audit(prisma, {
    action: AuditAction.FIAT_WITHDRAWAL_PAID,
    actorType: 'ADMIN',
    actorAdminId: adminId,
    entityType: 'fiat_withdrawal',
    entityId: row.id,
    after: { payoutReference, netUsd: net.toFixed(2) },
  });
}

/**
 * Refuses a withdrawal and releases the reservation.
 *
 * The release happens before the status changes. If the status update then
 * fails, the row is still REQUESTED with nothing reserved, and any later attempt
 * to pay it is refused by the ledger's sign constraint — a safe failure. The
 * other order would risk a rejected withdrawal whose funds stay frozen.
 */
export async function rejectFiatWithdrawal(
  adminId: string,
  withdrawalId: string,
  input: { note: string },
) {
  const note = required(input.note, 8, 'Say why in at least 8 characters. The participant sees this.');

  const row = await prisma.fiatWithdrawal.findUnique({ where: { id: withdrawalId } });
  if (!row) throw new NotFoundError('Withdrawal');
  if (row.status !== 'REQUESTED') {
    throw new ValidationError(`This withdrawal is already ${row.status.toLowerCase()}.`);
  }

  try {
    await unlockFunds({
      userId: row.userId,
      asset: row.asset,
      amount: new Decimal(row.amountUsd.toString()),
      reference: `fiat-withdrawal-unlock:${row.id}`,
      memo: `Cash withdrawal ${row.reference} rejected; releasing the reservation`,
    });
  } catch (error) {
    // Already released by an earlier attempt: that is the outcome we want.
    if (!isUniqueViolation(error)) throw error;
  }

  const updated = await prisma.fiatWithdrawal.updateMany({
    where: { id: row.id, status: 'REQUESTED' },
    data: { status: 'REJECTED', note, rejectedAt: new Date(), rejectedById: adminId },
  });
  if (updated.count === 0) {
    throw new ValidationError('Another operator has already handled this withdrawal.');
  }

  await audit(prisma, {
    action: AuditAction.FIAT_WITHDRAWAL_REJECTED,
    actorType: 'ADMIN',
    actorAdminId: adminId,
    entityType: 'fiat_withdrawal',
    entityId: row.id,
    after: { note },
  });
}

export async function listFiatWithdrawalsForUser(userId: string) {
  return prisma.fiatWithdrawal.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
}

export async function listFiatWithdrawalsForReview() {
  return prisma.fiatWithdrawal.findMany({
    where: { status: 'REQUESTED' },
    include: { user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
}
