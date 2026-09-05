import type { Withdrawal } from '@prisma/client';
import { Decimal, USD_SCALE } from '../domain/money';
import {
  ForbiddenError,
  InsufficientFundsError,
  NotFoundError,
  ValidationError,
} from '../domain/errors';
import { newId } from '../domain/id';
import { withdrawalMachine, type WithdrawalState } from '../domain/state/index';
import { blockchainProvider, liquidityProvider } from '../providers/registry';
import { generateNumericCode, hashToken } from '../server/crypto';
import { inTransaction, prisma, type Tx } from '../server/db';
import { AccountCode } from './accounts';
import { AuditAction, audit, type AuditContext } from './audit';
import { ledgerKey } from './idempotency';
import * as journal from './journal';
import { getAccountBalance, postTransaction } from './ledger';
import { assertWithinWithdrawalLimits, getCustomerStanding } from './limits';
import { screenOrThrow } from './screening';
import { requestApproval } from './treasury';
import { recordProviderCall } from './provider-log';

/**
 * Crypto withdrawals to external wallets.
 *
 * Three properties this file exists to guarantee:
 *   1. A withdrawal cannot be submitted without a second-factor confirmation.
 *   2. Funds are moved into a hold the moment the customer confirms — before any
 *      provider call — so two concurrent withdrawals cannot spend the same coins.
 *   3. A failed or rejected withdrawal always releases its hold. Money is never
 *      stranded.
 */

const CONFIRMATION_TTL_MS = 10 * 60_000;
const MAX_CONFIRMATION_ATTEMPTS = 5;

export interface RequestWithdrawalInput {
  userId: string;
  assetSymbol: string;
  /** Gross amount to debit, inclusive of fees. */
  amount: string;
  /** Must belong to a wallet the customer has already saved. */
  walletId: string;
  idempotencyKey: string;
}

export interface WithdrawalRequestResult {
  withdrawal: Withdrawal;
  /**
   * Development only. In production the code is delivered out-of-band and never
   * returned by the API — see the Notifier note below.
   */
  confirmationCode?: string;
}

export async function requestWithdrawal(
  input: RequestWithdrawalInput,
  context: AuditContext = {},
): Promise<WithdrawalRequestResult> {
  const existing = await prisma.withdrawal.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return { withdrawal: existing };

  const asset = await prisma.asset.findUnique({ where: { symbol: input.assetSymbol } });
  if (!asset) throw new NotFoundError(`Asset ${input.assetSymbol}`);
  if (asset.kind !== 'CRYPTO') {
    throw new ValidationError('Only crypto withdrawals are supported here');
  }
  if (!asset.isActive || !asset.withdrawalEnabled) {
    throw new ValidationError(`${asset.symbol} withdrawals are currently disabled`);
  }

  const wallet = await prisma.wallet.findUnique({ where: { id: input.walletId } });
  if (!wallet || wallet.userId !== input.userId) throw new NotFoundError('Wallet');
  if (wallet.assetId !== asset.id) {
    throw new ValidationError('That wallet is for a different asset');
  }
  if (!wallet.isActive) throw new ValidationError('That wallet has been removed');

  const amount = parseAmount(input.amount, asset.quoteScale, asset.symbol);
  const minimum = new Decimal(asset.minWithdrawal.toString());
  if (minimum.gt(0) && amount.lt(minimum)) {
    throw new ValidationError(
      `The minimum ${asset.symbol} withdrawal is ${minimum.toFixed()}`,
    );
  }

  const standing = await getCustomerStanding(prisma, input.userId);
  const usdValue = await estimateUsdValue(asset.symbol, amount);
  await assertWithinWithdrawalLimits(prisma, standing, usdValue);

  const chain = blockchainProvider();
  if (!chain.validateAddress(asset.symbol, wallet.network, wallet.address)) {
    throw new ValidationError('That address is not valid for this network');
  }

  // Screen the destination BEFORE anything is held or sent. Sending funds to a
  // sanctioned address is the single worst outcome available to this system, so
  // the outbound policy is deliberately stricter than the inbound one.
  const screening = await screenOrThrow(
    { address: wallet.address, chain: wallet.network, direction: 'OUTBOUND' },
    context,
  );

  const feeEstimate = await recordProviderCall(
    {
      provider: chain.meta.name,
      providerKind: 'BLOCKCHAIN',
      operation: 'estimateFee',
      idempotencyKey: `blockchain:estimateFee:${input.idempotencyKey}`,
      request: { symbol: asset.symbol, network: wallet.network, amount: amount.toFixed() },
    },
    () => chain.estimateFee(asset.symbol, wallet.network, amount.toFixed()),
  );

  const networkFee = new Decimal(feeEstimate.data.fee);
  const brokerageFee = new Decimal(0); // No withdrawal markup in the MVP.
  const netAmount = amount.minus(networkFee).minus(brokerageFee);

  if (!netAmount.isPositive()) {
    throw new ValidationError(
      `The network fee of ${networkFee.toFixed()} ${asset.symbol} exceeds the amount requested`,
    );
  }

  // Check availability now for a fast, clear error. The hold at confirmation
  // time is what actually protects the funds.
  const available = await getAccountBalance(prisma, {
    code: AccountCode.USER_CRYPTO,
    assetId: asset.id,
    userId: input.userId,
  });
  if (available.natural.lt(amount)) {
    throw new InsufficientFundsError(
      asset.symbol,
      amount.toFixed(),
      available.natural.toFixed(),
    );
  }

  const code = generateNumericCode(6);

  const withdrawal = await prisma.withdrawal.create({
    data: {
      id: newId(),
      userId: input.userId,
      kind: 'CRYPTO',
      assetId: asset.id,
      walletId: wallet.id,
      amount: amount.toFixed(),
      brokerageFee: brokerageFee.toFixed(),
      networkFee: networkFee.toFixed(),
      netAmount: netAmount.toFixed(),
      destinationAddress: wallet.address,
      network: wallet.network,
      status: 'AWAITING_CONFIRMATION',
      provider: chain.meta.name,
      requiredConfirmations: 1,
      idempotencyKey: input.idempotencyKey,
      confirmationCodes: {
        create: {
          id: newId(),
          codeHash: hashToken(code),
          expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
        },
      },
    },
  });

  if (screening.decision === 'REVIEW') {
    // Not a rejection: a human decides. The withdrawal stays unconfirmed and no
    // funds are held until they do.
    await requestApproval(
      prisma,
      {
        entityType: 'Withdrawal',
        entityId: withdrawal.id,
        reason: `Destination screened ${screening.risk}: ${screening.reasons.join(', ')}`,
        valueUsd: usdValue,
      },
      context,
    );
  }

  await audit(prisma, {
    ...context,
    actorType: 'USER',
    actorUserId: input.userId,
    action: AuditAction.WITHDRAWAL_REQUESTED,
    entityType: 'Withdrawal',
    entityId: withdrawal.id,
    after: {
      asset: asset.symbol,
      amount: amount.toFixed(),
      address: wallet.address,
      networkFee: networkFee.toFixed(),
      screeningRisk: screening.risk,
      screeningDecision: screening.decision,
    },
  });

  // MISSING DEPENDENCY: there is no SMS/email delivery channel configured, so
  // the code is returned to the caller in development. Before production this
  // must go through a Notifier that sends it out-of-band — a confirmation code
  // returned in the same response it protects is not a second factor.
  return { withdrawal, confirmationCode: code };
}

/**
 * Confirm a withdrawal and place the hold.
 *
 * The hold is posted in the same database transaction that verifies the code,
 * so there is no window in which a confirmed withdrawal has unprotected funds.
 */
export async function confirmWithdrawal(
  params: { withdrawalId: string; userId: string; code: string },
  context: AuditContext = {},
): Promise<Withdrawal> {
  return inTransaction(async (tx) => {
    const withdrawal = await tx.withdrawal.findUnique({
      where: { id: params.withdrawalId },
      include: { confirmationCodes: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (!withdrawal || withdrawal.userId !== params.userId) {
      throw new NotFoundError('Withdrawal');
    }
    if (withdrawal.status === 'CONFIRMED' || withdrawal.status === 'SUBMITTED') {
      return withdrawal;
    }
    if (withdrawal.status !== 'AWAITING_CONFIRMATION') {
      throw new ValidationError(`This withdrawal is ${withdrawal.status.toLowerCase()}`);
    }

    const confirmation = withdrawal.confirmationCodes[0];
    if (!confirmation) throw new ValidationError('No confirmation is pending');
    if (confirmation.consumedAt) throw new ValidationError('That code has already been used');
    if (confirmation.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError('That code has expired. Start the withdrawal again.');
    }
    if (confirmation.attempts >= MAX_CONFIRMATION_ATTEMPTS) {
      throw new ForbiddenError('Too many incorrect codes. Start the withdrawal again.');
    }

    if (confirmation.codeHash !== hashToken(params.code)) {
      await tx.withdrawalConfirmation.update({
        where: { id: confirmation.id },
        data: { attempts: { increment: 1 } },
      });
      throw new ValidationError('That code is not correct');
    }

    await tx.withdrawalConfirmation.update({
      where: { id: confirmation.id },
      data: { consumedAt: new Date() },
    });

    const amount = new Decimal(withdrawal.amount.toString());
    const assetId = withdrawal.assetId!;

    // Re-check availability inside the transaction. Under SERIALIZABLE isolation
    // this is what makes two concurrent withdrawals of the same funds impossible.
    const available = await getAccountBalance(tx, {
      code: AccountCode.USER_CRYPTO,
      assetId,
      userId: withdrawal.userId,
    });
    if (available.natural.lt(amount)) {
      throw new InsufficientFundsError(
        assetId,
        amount.toFixed(),
        available.natural.toFixed(),
      );
    }

    const template = journal.placeHold({
      userId: withdrawal.userId,
      assetId,
      amount,
      reason: 'WITHDRAWAL',
      isFiat: false,
    });

    await postTransaction(tx, {
      type: template.type,
      referenceType: 'Withdrawal',
      referenceId: withdrawal.id,
      idempotencyKey: ledgerKey('Withdrawal', withdrawal.id, 'hold'),
      description: template.description,
      occurredAt: new Date(),
      metadata: { userId: withdrawal.userId, withdrawalId: withdrawal.id },
      legs: template.legs,
    });

    const confirmed = await transitionWithdrawal(tx, withdrawal, 'CONFIRMED', {
      confirmedAt: new Date(),
    });

    await audit(tx, {
      ...context,
      actorType: 'USER',
      actorUserId: withdrawal.userId,
      action: AuditAction.WITHDRAWAL_CONFIRMED,
      entityType: 'Withdrawal',
      entityId: withdrawal.id,
      after: { held: amount.toFixed() },
    });

    return confirmed;
  });
}

/** Send a confirmed withdrawal to the custody provider. */
export async function submitWithdrawal(
  withdrawalId: string,
  context: AuditContext = {},
): Promise<Withdrawal> {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw new NotFoundError('Withdrawal');
  if (withdrawal.status !== 'CONFIRMED') return withdrawal;

  // A withdrawal flagged for review does not leave until a human clears it.
  const approval = await prisma.manualApproval.findUnique({
    where: { entityType_entityId: { entityType: 'Withdrawal', entityId: withdrawal.id } },
  });
  if (approval && approval.status !== 'APPROVED') {
    throw new ForbiddenError(
      'This withdrawal is being reviewed. You will be notified when it completes.',
    );
  }

  const asset = await prisma.asset.findUniqueOrThrow({ where: { id: withdrawal.assetId! } });
  const chain = blockchainProvider();

  let result;
  try {
    result = await recordProviderCall(
      {
        provider: chain.meta.name,
        providerKind: 'BLOCKCHAIN',
        operation: 'createWithdrawal',
        idempotencyKey: `blockchain:createWithdrawal:${withdrawal.id}`,
        referenceType: 'Withdrawal',
        referenceId: withdrawal.id,
        request: {
          symbol: asset.symbol,
          network: withdrawal.network,
          address: withdrawal.destinationAddress,
          amount: withdrawal.netAmount.toString(),
        },
      },
      () =>
        chain.createWithdrawal({
          idempotencyKey: `withdrawal:${withdrawal.id}`,
          symbol: asset.symbol,
          network: withdrawal.network!,
          address: withdrawal.destinationAddress!,
          amount: withdrawal.netAmount.toString(),
          reference: withdrawal.id,
        }),
    );
  } catch (error) {
    // The provider refused outright. Release the hold — the customer's funds
    // must not stay frozen because of our failure.
    await failWithdrawal(
      withdrawal.id,
      error instanceof Error ? error.message : 'Provider rejected the withdrawal',
      context,
    );
    throw error;
  }

  if (result.data.status === 'FAILED') {
    return failWithdrawal(
      withdrawal.id,
      result.data.failureReason ?? 'Provider rejected the withdrawal',
      context,
    );
  }

  const submitted = await inTransaction(async (tx) => {
    const current = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    if (current.status !== 'CONFIRMED') return current;

    const next = await transitionWithdrawal(tx, current, 'SUBMITTED', {
      externalId: result.data.externalId,
      txHash: result.data.txHash ?? null,
      requiredConfirmations: result.data.requiredConfirmations,
      networkFee: result.data.fee,
      submittedAt: new Date(),
    });

    await audit(tx, {
      ...context,
      actorType: 'SYSTEM',
      actorUserId: withdrawal.userId,
      action: AuditAction.WITHDRAWAL_SUBMITTED,
      entityType: 'Withdrawal',
      entityId: withdrawal.id,
      after: { externalId: result.data.externalId, txHash: result.data.txHash },
    });

    return next;
  });

  return submitted;
}

/**
 * Poll the provider and, once the transaction has enough confirmations, post the
 * ledger entries that actually move the coins off our books.
 */
export async function pollWithdrawal(
  withdrawalId: string,
  context: AuditContext = {},
): Promise<Withdrawal> {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw new NotFoundError('Withdrawal');
  if (withdrawal.status !== 'SUBMITTED' && withdrawal.status !== 'BROADCAST') {
    return withdrawal;
  }
  if (!withdrawal.externalId) return withdrawal;

  const chain = blockchainProvider();
  const tx = await chain.getTransaction(withdrawal.externalId);

  if (tx.data.status === 'FAILED' || tx.data.status === 'DROPPED') {
    return failWithdrawal(withdrawal.id, 'The transaction failed on-chain', context);
  }

  const confirmations = tx.data.confirmations;
  if (confirmations < withdrawal.requiredConfirmations) {
    return prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        confirmations,
        status: withdrawal.status === 'SUBMITTED' ? 'BROADCAST' : withdrawal.status,
        txHash: tx.data.txHash || withdrawal.txHash,
        version: { increment: 1 },
      },
    });
  }

  return completeWithdrawal(withdrawal.id, confirmations, tx.data.txHash, context);
}

/** Post the ledger entries for a confirmed on-chain withdrawal. */
async function completeWithdrawal(
  withdrawalId: string,
  confirmations: number,
  txHash: string,
  context: AuditContext,
): Promise<Withdrawal> {
  return inTransaction(async (tx) => {
    const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
    if (withdrawal.status === 'COMPLETED') return withdrawal;

    const template = journal.cryptoWithdrawal({
      userId: withdrawal.userId,
      cryptoAssetId: withdrawal.assetId!,
      heldAmount: new Decimal(withdrawal.amount.toString()),
      networkFee: new Decimal(withdrawal.networkFee.toString()),
      brokerageFee: new Decimal(withdrawal.brokerageFee.toString()),
    });

    await postTransaction(tx, {
      type: template.type,
      referenceType: 'Withdrawal',
      referenceId: withdrawal.id,
      idempotencyKey: ledgerKey('Withdrawal', withdrawal.id, 'complete'),
      description: template.description,
      occurredAt: new Date(),
      metadata: {
        userId: withdrawal.userId,
        withdrawalId: withdrawal.id,
        txHash,
      },
      legs: template.legs,
    });

    const completed = await transitionWithdrawal(tx, withdrawal, 'COMPLETED', {
      confirmations,
      txHash,
      completedAt: new Date(),
    });

    await audit(tx, {
      ...context,
      actorType: 'SYSTEM',
      actorUserId: withdrawal.userId,
      action: AuditAction.WITHDRAWAL_COMPLETED,
      entityType: 'Withdrawal',
      entityId: withdrawal.id,
      after: { txHash, confirmations },
    });

    return completed;
  });
}

/**
 * Fail a withdrawal and release its hold.
 *
 * Releasing is conditional on a hold having been placed: a withdrawal that fails
 * before confirmation never had one, and releasing a hold that does not exist
 * would credit the customer money they never spent.
 */
export async function failWithdrawal(
  withdrawalId: string,
  reason: string,
  context: AuditContext = {},
): Promise<Withdrawal> {
  return inTransaction(async (tx) => {
    const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
    if (withdrawal.status === 'FAILED' || withdrawal.status === 'COMPLETED') {
      return withdrawal;
    }

    const hold = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: ledgerKey('Withdrawal', withdrawal.id, 'hold') },
    });

    if (hold) {
      const template = journal.releaseHold({
        userId: withdrawal.userId,
        assetId: withdrawal.assetId!,
        amount: new Decimal(withdrawal.amount.toString()),
        reason: 'WITHDRAWAL',
        isFiat: withdrawal.kind === 'FIAT',
      });

      await postTransaction(tx, {
        type: template.type,
        referenceType: 'Withdrawal',
        referenceId: withdrawal.id,
        idempotencyKey: ledgerKey('Withdrawal', withdrawal.id, 'release'),
        description: `Release hold for failed withdrawal: ${reason}`,
        occurredAt: new Date(),
        metadata: { userId: withdrawal.userId, withdrawalId: withdrawal.id, reason },
        legs: template.legs,
      });
    }

    const failed = await transitionWithdrawal(tx, withdrawal, 'FAILED', {
      failureReason: reason,
    });

    await audit(tx, {
      ...context,
      actorType: 'SYSTEM',
      actorUserId: withdrawal.userId,
      action: AuditAction.WITHDRAWAL_FAILED,
      entityType: 'Withdrawal',
      entityId: withdrawal.id,
      after: { reason, holdReleased: Boolean(hold) },
    });

    return failed;
  });
}

/** Customer cancels before confirming. No hold exists yet, so nothing to release. */
export async function cancelWithdrawal(
  params: { withdrawalId: string; userId: string },
  context: AuditContext = {},
): Promise<Withdrawal> {
  return inTransaction(async (tx) => {
    const withdrawal = await tx.withdrawal.findUnique({ where: { id: params.withdrawalId } });
    if (!withdrawal || withdrawal.userId !== params.userId) throw new NotFoundError('Withdrawal');
    if (withdrawal.status === 'CANCELLED') return withdrawal;

    const hold = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: ledgerKey('Withdrawal', withdrawal.id, 'hold') },
    });
    if (hold) {
      const template = journal.releaseHold({
        userId: withdrawal.userId,
        assetId: withdrawal.assetId!,
        amount: new Decimal(withdrawal.amount.toString()),
        reason: 'WITHDRAWAL',
        isFiat: withdrawal.kind === 'FIAT',
      });
      await postTransaction(tx, {
        type: template.type,
        referenceType: 'Withdrawal',
        referenceId: withdrawal.id,
        idempotencyKey: ledgerKey('Withdrawal', withdrawal.id, 'release'),
        description: 'Release hold for cancelled withdrawal',
        occurredAt: new Date(),
        metadata: { userId: withdrawal.userId, withdrawalId: withdrawal.id },
        legs: template.legs,
      });
    }

    const cancelled = await transitionWithdrawal(tx, withdrawal, 'CANCELLED', {});
    await audit(tx, {
      ...context,
      actorType: 'USER',
      actorUserId: withdrawal.userId,
      action: AuditAction.WITHDRAWAL_FAILED,
      entityType: 'Withdrawal',
      entityId: withdrawal.id,
      after: { cancelled: true },
    });
    return cancelled;
  });
}

async function transitionWithdrawal(
  tx: Tx,
  withdrawal: Withdrawal,
  to: WithdrawalState,
  data: Record<string, unknown>,
): Promise<Withdrawal> {
  withdrawalMachine.assertTransition(withdrawal.status as WithdrawalState, to);

  const result = await tx.withdrawal.updateMany({
    where: { id: withdrawal.id, version: withdrawal.version },
    data: { ...data, status: to, version: { increment: 1 } } as never,
  });
  if (result.count === 0) {
    return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
  }
  return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
}

/**
 * USD value of a crypto amount, for limit checks. Uses the live venue price;
 * stablecoins short-circuit to par.
 */
async function estimateUsdValue(symbol: string, amount: Decimal): Promise<Decimal> {
  if (symbol === 'USD') return amount;
  try {
    const quote = await liquidityProvider().getQuote({
      symbol,
      quoteCurrency: 'USD',
      side: 'SELL',
      cryptoAmount: amount.toFixed(),
    });
    return new Decimal(quote.data.fiatAmount).toDecimalPlaces(USD_SCALE);
  } catch {
    // If the venue is unreachable we must not silently treat the value as zero
    // and wave the withdrawal past its limit check.
    throw new ValidationError(
      'Cannot value this withdrawal right now. Please try again shortly.',
    );
  }
}

function parseAmount(raw: string, scale: number, symbol: string): Decimal {
  let value: Decimal;
  try {
    value = new Decimal(raw);
  } catch {
    throw new ValidationError(`${symbol} amount is not a valid number`);
  }
  if (!value.isFinite() || !value.isPositive()) {
    throw new ValidationError(`${symbol} amount must be greater than zero`);
  }
  if (value.decimalPlaces() > scale) {
    throw new ValidationError(`${symbol} amounts are limited to ${scale} decimal places`);
  }
  return value;
}
