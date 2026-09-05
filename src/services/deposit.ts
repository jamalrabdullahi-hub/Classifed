import type { Deposit } from '@prisma/client';
import { Decimal, USD_SCALE } from '../domain/money';
import { NotFoundError, ProviderError, ValidationError } from '../domain/errors';
import { newId, randomToken } from '../domain/id';
import { depositMachine } from '../domain/state/index';
import { paymentProvider } from '../providers/registry';
import { inTransaction, prisma, type DbClient } from '../server/db';
import { AuditAction, audit, type AuditContext } from './audit';
import { ledgerKey } from './idempotency';
import * as journal from './journal';
import { postTransaction } from './ledger';
import { getCustomerStanding } from './limits';
import { recordProviderCall } from './provider-log';

/**
 * USD deposits.
 *
 * The single most important rule in this file: **a webhook never credits a
 * customer.** A webhook is only a hint that something happened. Crediting always
 * goes through `creditDeposit`, which re-verifies with the provider out-of-band
 * first. That way a forged, replayed or simply wrong webhook cannot mint money.
 */

export interface CreateDepositInput {
  userId: string;
  amount: string;
  payerAccountRef: string;
  /** Set when the deposit is funding a specific order. */
  orderId?: string | null;
  idempotencyKey: string;
}

export async function createDeposit(
  input: CreateDepositInput,
  context: AuditContext = {},
): Promise<Deposit> {
  const amount = parseUsd(input.amount);
  const standing = await getCustomerStanding(prisma, input.userId);
  if (standing.tier < 1) {
    throw new ValidationError('Complete identity verification before depositing');
  }

  // A retry with the same key must not create a second payment request.
  const existing = await prisma.deposit.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return existing;

  const provider = paymentProvider();
  const reference = `dep_${randomToken(9)}`;

  const paymentAccount = await upsertPaymentAccount(
    prisma,
    input.userId,
    provider.meta.name,
    input.payerAccountRef,
  );

  const depositId = newId();

  const intent = await recordProviderCall(
    {
      provider: provider.meta.name,
      providerKind: 'PAYMENT',
      operation: 'createDeposit',
      idempotencyKey: `payment:createDeposit:${input.idempotencyKey}`,
      referenceType: 'Deposit',
      referenceId: depositId,
      request: { amount: amount.toFixed(USD_SCALE), reference },
    },
    () =>
      provider.createDeposit({
        idempotencyKey: input.idempotencyKey,
        reference,
        amount: amount.toFixed(USD_SCALE),
        currency: 'USD',
        payerAccountRef: input.payerAccountRef,
        description: 'FLTCrypto USD deposit',
      }),
  );

  const providerFee = new Decimal(intent.data.fee ?? '0');

  const deposit = await prisma.deposit.create({
    data: {
      id: depositId,
      userId: input.userId,
      orderId: input.orderId ?? null,
      paymentAccountId: paymentAccount.id,
      provider: provider.meta.name,
      currency: 'USD',
      amount: amount.toFixed(),
      providerFee: providerFee.toFixed(),
      netAmount: amount.minus(providerFee).toFixed(),
      status: intent.data.status === 'SUCCEEDED' ? 'CONFIRMED' : 'AWAITING_PAYMENT',
      externalId: intent.data.externalId,
      idempotencyKey: input.idempotencyKey,
      reference,
    },
  });

  await audit(prisma, {
    ...context,
    actorType: 'USER',
    actorUserId: input.userId,
    action: AuditAction.DEPOSIT_CREATED,
    entityType: 'Deposit',
    entityId: deposit.id,
    after: { amount: amount.toFixed(), externalId: intent.data.externalId },
  });

  return deposit;
}

/**
 * Verify a deposit with the provider and, if it really settled, credit it.
 *
 * Called from three places — the webhook handler, the customer polling the
 * status page, and the reconciler. All three are safe to call repeatedly: the
 * ledger posting is keyed on the deposit id, so the credit happens exactly once
 * however many times we are told about it.
 */
export async function verifyAndCreditDeposit(
  depositId: string,
  context: AuditContext = {},
): Promise<Deposit> {
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
  if (!deposit) throw new NotFoundError('Deposit');

  if (deposit.status === 'CREDITED') return deposit;
  if (!deposit.externalId) {
    throw new ProviderError(deposit.provider, 'Deposit has no provider reference to verify');
  }
  if (depositMachine.isTerminal(deposit.status)) return deposit;

  const provider = paymentProvider();
  const verified = await recordProviderCall(
    {
      provider: provider.meta.name,
      providerKind: 'PAYMENT',
      operation: 'verifyDeposit',
      // Verification is a read; a fresh key each time so retries actually re-query.
      idempotencyKey: `payment:verifyDeposit:${deposit.id}:${randomToken(6)}`,
      referenceType: 'Deposit',
      referenceId: deposit.id,
      request: { externalId: deposit.externalId },
    },
    () => provider.verifyDeposit(deposit.externalId!),
  );

  if (verified.data.status === 'FAILED') {
    return failDeposit(deposit.id, verified.data.failureReason ?? 'Provider reported failure', context);
  }
  if (verified.data.status !== 'SUCCEEDED') {
    // Still pending. Nothing to do; the caller will ask again.
    return deposit;
  }

  // The provider is authoritative on the amount, not our record and certainly
  // not the webhook. A mismatch is an incident, not something to paper over.
  const verifiedAmount = new Decimal(verified.data.amount);
  const recordedAmount = new Decimal(deposit.amount.toString());
  if (!verifiedAmount.eq(recordedAmount)) {
    await audit(prisma, {
      ...context,
      actorType: 'SYSTEM',
      action: AuditAction.DEPOSIT_FAILED,
      entityType: 'Deposit',
      entityId: deposit.id,
      before: { recorded: recordedAmount.toFixed() },
      after: { verified: verifiedAmount.toFixed() },
    });
    throw new ProviderError(
      deposit.provider,
      `Provider reports ${verifiedAmount.toFixed()} but the deposit records ${recordedAmount.toFixed()}. Refusing to credit.`,
    );
  }

  const providerFee = new Decimal(verified.data.fee ?? deposit.providerFee.toString());
  return creditDeposit(deposit.id, providerFee, context);
}

/** Post the ledger entries for a settled deposit. Idempotent by construction. */
export async function creditDeposit(
  depositId: string,
  providerFee: Decimal,
  context: AuditContext = {},
): Promise<Deposit> {
  return inTransaction(async (tx) => {
    const deposit = await tx.deposit.findUnique({ where: { id: depositId } });
    if (!deposit) throw new NotFoundError('Deposit');
    if (deposit.status === 'CREDITED') return deposit;

    depositMachine.assertTransition(deposit.status, 'CONFIRMED');

    const usdAsset = await tx.asset.findUnique({ where: { symbol: 'USD' } });
    if (!usdAsset) throw new NotFoundError('Asset USD');

    const gross = new Decimal(deposit.amount.toString());
    const template = journal.usdDeposit({
      userId: deposit.userId,
      usdAssetId: usdAsset.id,
      grossAmount: gross,
      providerFee,
    });

    await postTransaction(tx, {
      type: template.type,
      referenceType: 'Deposit',
      referenceId: deposit.id,
      // Keyed on the deposit, so however many webhooks or polls arrive, the
      // customer is credited exactly once.
      idempotencyKey: ledgerKey('Deposit', deposit.id, 'credit'),
      description: template.description,
      occurredAt: new Date(),
      metadata: { userId: deposit.userId, depositId: deposit.id },
      legs: template.legs,
    });

    // Settlement: move the claim from the provider's clearing account into our
    // own operating balance. The mock provider settles instantly; a real one
    // settles on its own schedule and needs a settlement report or webhook, at
    // which point this posting moves out of the credit path. Until then the
    // reconciler watches PAYMENT_CLEARING for anything that lingers.
    const settlement = journal.usdSettlement({
      usdAssetId: usdAsset.id,
      amount: gross.minus(providerFee),
    });
    await postTransaction(tx, {
      type: settlement.type,
      referenceType: 'Deposit',
      referenceId: deposit.id,
      idempotencyKey: ledgerKey('Deposit', deposit.id, 'settlement'),
      description: settlement.description,
      occurredAt: new Date(),
      metadata: { depositId: deposit.id, provider: deposit.provider },
      legs: settlement.legs,
    });

    const updated = await tx.deposit.update({
      where: { id: deposit.id },
      data: {
        status: 'CREDITED',
        providerFee: providerFee.toFixed(),
        netAmount: gross.minus(providerFee).toFixed(),
        confirmedAt: deposit.confirmedAt ?? new Date(),
        creditedAt: new Date(),
        version: { increment: 1 },
      },
    });

    await audit(tx, {
      ...context,
      actorType: 'SYSTEM',
      actorUserId: deposit.userId,
      action: AuditAction.DEPOSIT_CREDITED,
      entityType: 'Deposit',
      entityId: deposit.id,
      after: { amount: gross.toFixed(), providerFee: providerFee.toFixed() },
    });

    return updated;
  });
}

export async function failDeposit(
  depositId: string,
  reason: string,
  context: AuditContext = {},
): Promise<Deposit> {
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
  if (!deposit) throw new NotFoundError('Deposit');
  if (deposit.status === 'FAILED') return deposit;

  depositMachine.assertTransition(deposit.status, 'FAILED');

  const updated = await prisma.deposit.update({
    where: { id: deposit.id },
    data: { status: 'FAILED', failureReason: reason, version: { increment: 1 } },
  });

  await audit(prisma, {
    ...context,
    actorType: 'SYSTEM',
    actorUserId: deposit.userId,
    action: AuditAction.DEPOSIT_FAILED,
    entityType: 'Deposit',
    entityId: deposit.id,
    after: { reason },
  });

  return updated;
}

/**
 * Reverse a credited deposit — a chargeback, or a provider correction. The
 * original entries stay; a mirrored transaction undoes their effect.
 */
export async function reverseDeposit(
  depositId: string,
  reason: string,
  context: AuditContext = {},
): Promise<Deposit> {
  return inTransaction(async (tx) => {
    const deposit = await tx.deposit.findUnique({ where: { id: depositId } });
    if (!deposit) throw new NotFoundError('Deposit');
    if (deposit.status === 'REVERSED') return deposit;

    depositMachine.assertTransition(deposit.status, 'REVERSED');

    const original = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: ledgerKey('Deposit', deposit.id, 'credit') },
    });
    if (!original) {
      throw new NotFoundError('Ledger transaction for this deposit');
    }

    const { reverseTransaction } = await import('./ledger');
    await reverseTransaction(tx, {
      transactionId: original.id,
      idempotencyKey: ledgerKey('Deposit', deposit.id, 'reversal'),
      reason,
    });

    const updated = await tx.deposit.update({
      where: { id: deposit.id },
      data: { status: 'REVERSED', failureReason: reason, version: { increment: 1 } },
    });

    await audit(tx, {
      ...context,
      actorType: 'SYSTEM',
      actorUserId: deposit.userId,
      action: AuditAction.LEDGER_ADJUSTMENT,
      entityType: 'Deposit',
      entityId: deposit.id,
      after: { reversed: true, reason },
    });

    return updated;
  });
}

async function upsertPaymentAccount(
  db: DbClient,
  userId: string,
  provider: string,
  accountRef: string,
) {
  const existing = await db.paymentAccount.findUnique({
    where: { userId_provider_accountRef: { userId, provider, accountRef } },
  });
  if (existing) return existing;

  return db.paymentAccount.create({
    data: {
      id: newId(),
      userId,
      provider,
      kind: 'MOBILE_MONEY',
      accountRef,
    },
  });
}

function parseUsd(raw: string): Decimal {
  let value: Decimal;
  try {
    value = new Decimal(raw);
  } catch {
    throw new ValidationError('Deposit amount is not a valid number');
  }
  if (!value.isFinite() || !value.isPositive()) {
    throw new ValidationError('Deposit amount must be greater than zero');
  }
  if (value.decimalPlaces() > USD_SCALE) {
    throw new ValidationError('Deposit amount cannot be more precise than cents');
  }
  return value;
}
