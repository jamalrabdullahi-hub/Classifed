import {
  FiatDepositMethod,
  FiatDepositStatus,
  LedgerAccountKind,
  LedgerTransferKind,
  prisma,
  type FiatDeposit,
  type User,
} from '@flt/db';
import { env } from '@flt/config';
import { NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { PERMISSIONS, assertCan, recordAdminAction, type AdminActionContext } from './admin';
import { accountFor, postTransfer } from './ledger';
import { verifyErc20Transfer } from './onchain-payments';

/**
 * Fiat in, converted into the participant's custodial balance.
 *
 * ## The shape of it
 *
 * A participant says money is coming and is given a reference. Cash arrives in
 * FLT's bank or EVC account; an operator matches the reference against the
 * statement and confirms it. FLT then owes them — a real debt, recorded in the
 * ledger. An operator converts that cash into the custodied stablecoin and it
 * lands in the omnibus; the fiat liability is discharged and the participant's
 * stablecoin balance goes up. See docs/adr/0004-custodial-omnibus.md.
 *
 * ## Why the liability window is modelled at all
 *
 * Between "cash arrived" and "stablecoin credited", FLT is holding somebody's
 * money and has given them nothing they can trade. That is the exposure this
 * feature carries, and it must be visible while it exists rather than
 * reconstructed afterwards. `outstandingFiatLiability` answers "what do we owe
 * right now", which is the question an operator, an auditor and a regulator all
 * ask first.
 *
 * ## What changes at the end, under custody
 *
 * The stablecoin lands in the omnibus, not in a wallet the participant controls,
 * so it is not discharged by a transfer out — it becomes a balance FLT owes and
 * records on the ledger. The conversion is therefore two ledger movements
 * against two assets: the USD liability is closed (as the pre-custody rail did),
 * and a stablecoin balance is opened against the omnibus. What the participant
 * holds afterwards is that ledger balance, and it is what the trade path spends.
 *
 * ## Neither leg is automatic
 *
 * A person watches a bank account and a person runs the conversion. Both demand
 * a reference, because an operator-confirmed movement with nothing to match it
 * against is indistinguishable from a mistake.
 */

/** The unit the ledger records fiat liabilities in. */
const LEDGER_ASSET = 'USD';

export interface DepositInstructions {
  depositId: string;
  reference: string;
  amountFiat: string;
  currency: string;
  method: FiatDepositMethod;
}

/**
 * Records that a participant intends to send money, and returns the reference
 * they must put on the transfer.
 *
 * Nothing is credited here and nothing is owed — this is a claim about the
 * future. The row exists so that when the money lands, there is something to
 * match it to.
 */
export async function requestFiatDeposit(
  user: User,
  input: {
    method: FiatDepositMethod;
    amountFiat: string;
    currency?: string;
    payerName: string;
    payerPhone: string;
  },
): Promise<DepositInstructions> {
  const amount = new Decimal(input.amountFiat);
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    throw new ValidationError('Enter how much you are sending');
  }

  /**
   * The participant needs somewhere for the crypto to go before they send
   * anything.
   *
   * Refused up front rather than discovered by an operator holding money with
   * nowhere to deliver it — at which point the only options are a refund or
   * sitting on somebody's cash.
   */
  const wallet = await prisma.wallet.findFirst({
    where: { userId: user.id, connector: 'privy-embedded' },
  });
  if (!wallet) {
    throw new ValidationError(
      'Create your FLT wallet first — that is where the money will arrive.',
    );
  }

  const open = await prisma.fiatDeposit.count({
    where: {
      userId: user.id,
      status: { in: [FiatDepositStatus.AWAITING_FUNDS, FiatDepositStatus.FUNDS_RECEIVED] },
    },
  });
  if (open >= 3) {
    throw new ValidationError(
      'You already have deposits in progress. They will be processed shortly.',
    );
  }

  const payerName = input.payerName.trim();
  const payerPhone = input.payerPhone.trim().replace(/[^\d+]/g, '');

  if (payerName.length < 2) {
    throw new ValidationError('Give the name on the account the money is coming from');
  }
  if (payerPhone.replace(/\D/g, '').length < 7) {
    throw new ValidationError('Give the number the money is coming from');
  }

  const deposit = await prisma.fiatDeposit.create({
    data: {
      id: newId(),
      userId: user.id,
      method: input.method,
      currency: (input.currency ?? 'USD').toUpperCase(),
      amountFiat: amount.toFixed(),
      payerName,
      payerPhone,
      reference: depositReference(),
    },
  });

  return {
    depositId: deposit.id,
    reference: deposit.reference,
    amountFiat: amount.toFixed(2),
    currency: deposit.currency,
    method: deposit.method,
  };
}

export async function listFiatDepositsForUser(userId: string): Promise<FiatDeposit[]> {
  return prisma.fiatDeposit.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
}

export async function listFiatDepositsForReview(status: FiatDepositStatus) {
  return prisma.fiatDeposit.findMany({
    where: { status },
    orderBy: { createdAt: status === FiatDepositStatus.AWAITING_FUNDS ? 'asc' : 'desc' },
    take: 100,
    include: {
      user: {
        select: {
          id: true,
          email: true,
          wallets: {
            where: { connector: 'privy-embedded' },
            select: { address: true, chainId: true },
          },
        },
      },
    },
  });
}

/**
 * Confirms that money actually arrived, and records what FLT now owes.
 *
 * The credited figure comes from `amountReceived`, not from what the
 * participant said they would send. Those differ often enough to matter — a
 * bank fee taken in transit, a wrong number typed at a counter — and crediting
 * the claim rather than the receipt would hand out money that never came.
 */
export async function confirmFiatReceived(
  context: AdminActionContext,
  input: {
    depositId: string;
    amountReceived: string;
    feeUsd: string;
    bankReference: string;
  },
): Promise<FiatDeposit> {
  assertCan(context.admin, PERMISSIONS.MANAGE_PAYOUTS);

  const deposit = await prisma.fiatDeposit.findUnique({ where: { id: input.depositId } });
  if (!deposit) throw new NotFoundError('Deposit');
  if (deposit.status !== FiatDepositStatus.AWAITING_FUNDS) {
    throw new ValidationError('This deposit has already been processed', { status: deposit.status });
  }
  if (!input.bankReference.trim()) {
    throw new ValidationError(
      'Record which statement line this matches. A confirmation with no reference is not reconciliation.',
    );
  }

  const received = new Decimal(input.amountReceived);
  const fee = new Decimal(input.feeUsd);

  if (!received.isFinite() || received.lessThanOrEqualTo(0)) {
    throw new ValidationError('Enter the amount that actually arrived');
  }
  if (!fee.isFinite() || fee.isNegative()) {
    throw new ValidationError('The fee cannot be negative');
  }
  if (fee.greaterThanOrEqualTo(received)) {
    throw new ValidationError('The fee cannot be the whole deposit');
  }

  const net = received.minus(fee);

  const updated = await prisma.$transaction(async (tx) => {
    const gateway = await accountFor(
      { kind: LedgerAccountKind.FIAT_GATEWAY, asset: LEDGER_ASSET },
      tx,
    );
    const client = await accountFor(
      { kind: LedgerAccountKind.USER_AVAILABLE, userId: deposit.userId, asset: LEDGER_ASSET },
      tx,
    );
    const revenue = await accountFor(
      { kind: LedgerAccountKind.FEE_REVENUE, asset: LEDGER_ASSET },
      tx,
    );

    /**
     * Cash in: an asset FLT holds goes up, and so does what FLT owes.
     *
     * In double entry that is a debit and two credits — see the sign
     * convention in ledger.ts. The fee is credited to revenue here rather than
     * netted silently, so what FLT took is a row somebody can point at.
     */
    await postTransfer(
      {
        kind: LedgerTransferKind.DEPOSIT,
        reference: `fiat:${deposit.id}`,
        memo: `Fiat deposit ${deposit.reference} received (${input.bankReference.trim()})`,
        createdByAdminId: context.admin.id,
        entries: [
          { accountId: gateway.id, amount: received },
          { accountId: client.id, amount: net.negated() },
          ...(fee.isZero() ? [] : [{ accountId: revenue.id, amount: fee.negated() }]),
        ],
      },
      tx,
    );

    return tx.fiatDeposit.update({
      where: { id: deposit.id },
      data: {
        status: FiatDepositStatus.FUNDS_RECEIVED,
        amountReceived: received.toFixed(),
        feeUsd: fee.toFixed(),
        netUsd: net.toFixed(),
        bankReference: input.bankReference.trim(),
        receivedAt: new Date(),
        receivedById: context.admin.id,
      },
    });
  });

  await recordAdminAction(prisma, context, {
    action: 'fiat_deposit.received',
    entityType: 'fiat_deposit',
    entityId: deposit.id,
    after: { received: received.toFixed(), fee: fee.toFixed(), net: net.toFixed() },
    reason: input.bankReference.trim(),
  });

  return updated;
}

/**
 * Records that the transfer has been broadcast.
 *
 * Deliberately does not touch the ledger. A transaction in the mempool is not
 * a delivered one — it can be dropped or replaced — and discharging a debt on
 * the strength of an operator pressing a button is the shape of the mistake
 * this whole model exists to avoid. The debt closes at the next step, against
 * a mined receipt.
 */
export async function recordFiatSent(
  context: AdminActionContext,
  input: { depositId: string; txHash: string; address: string; chainId: number },
): Promise<FiatDeposit> {
  assertCan(context.admin, PERMISSIONS.MANAGE_PAYOUTS);

  const deposit = await prisma.fiatDeposit.findUnique({ where: { id: input.depositId } });
  if (!deposit) throw new NotFoundError('Deposit');
  if (deposit.status !== FiatDepositStatus.FUNDS_RECEIVED) {
    throw new ValidationError('This deposit is not awaiting a transfer', { status: deposit.status });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash.trim())) {
    throw new ValidationError('Record the transaction hash of the transfer');
  }

  const updated = await prisma.fiatDeposit.update({
    where: { id: deposit.id },
    data: {
      status: FiatDepositStatus.SENT,
      deliveryAddress: input.address,
      deliveryChainId: input.chainId,
      deliveryTxHash: input.txHash.trim(),
      sentAt: new Date(),
      sentById: context.admin.id,
    },
  });

  await recordAdminAction(prisma, context, {
    action: 'fiat_deposit.sent',
    entityType: 'fiat_deposit',
    entityId: deposit.id,
    after: { address: input.address, txHash: input.txHash.trim() },
    reason: `Sent to ${input.address}`,
  });

  return updated;
}

/**
 * Records that the converted stablecoin has landed in the omnibus, and credits
 * the participant's balance.
 *
 * The transaction hash is required, and the destination checked is the omnibus
 * address from configuration — not the operator's input. FLT is asserting that
 * somebody else's money is now held for the participant, and an assertion of
 * that kind with nothing to check it against is the shape of every custody
 * scandal worth naming.
 */
export async function confirmFiatDelivered(
  context: AdminActionContext,
  input: { depositId: string; tokenAddress: string; treasuryAddress: string },
): Promise<FiatDeposit> {
  assertCan(context.admin, PERMISSIONS.MANAGE_PAYOUTS);

  const deposit = await prisma.fiatDeposit.findUnique({ where: { id: input.depositId } });
  if (!deposit) throw new NotFoundError('Deposit');
  if (deposit.status !== FiatDepositStatus.SENT) {
    throw new ValidationError('This deposit has no transfer awaiting confirmation', {
      status: deposit.status,
    });
  }
  if (!deposit.deliveryTxHash || !deposit.deliveryAddress || !deposit.deliveryChainId) {
    throw new ValidationError('This deposit has no recorded transfer');
  }

  const net = new Decimal(deposit.netUsd?.toString() ?? '0');
  if (net.lessThanOrEqualTo(0)) {
    throw new ValidationError('This deposit has no net amount recorded');
  }

  /**
   * The step that actually releases the funds, so it checks rather than
   * trusts.
   *
   * The transfer is verified against a mined receipt — token, sender,
   * recipient and amount — before the debt is discharged. Every earlier step
   * is somebody asserting something; this one is the chain agreeing. Without
   * it, "delivered" would mean an operator said so, and a typo in a hash would
   * close a debt that was never paid.
   */
  const token = await prisma.token.findFirst({
    where: {
      chainId: deposit.deliveryChainId,
      address: { equals: input.tokenAddress, mode: 'insensitive' },
    },
  });
  if (!token) {
    throw new ValidationError('That token is not in the registry for this chain');
  }

  /**
   * The destination is the omnibus, read from configuration rather than from
   * the operator's input. The check that matters is "did the stablecoin land in
   * the pooled wallet", and letting the operator name the destination would let
   * a typo satisfy a check that exists to catch typos.
   */
  const omnibusAddress = env().OMNIBUS_EVM_ADDRESS;
  if (!omnibusAddress) {
    throw new ValidationError(
      'Custody is not configured, so there is no omnibus for the converted funds to arrive at.',
    );
  }

  const expected = BigInt(
    net.times(new Decimal(10).pow(token.decimals)).toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(),
  );

  await verifyErc20Transfer({
    chainId: deposit.deliveryChainId,
    txHash: deposit.deliveryTxHash,
    tokenAddress: input.tokenAddress,
    from: input.treasuryAddress,
    to: omnibusAddress,
    expectedBaseUnits: expected,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const gateway = await accountFor(
      { kind: LedgerAccountKind.FIAT_GATEWAY, asset: LEDGER_ASSET },
      tx,
    );
    const clientUsd = await accountFor(
      { kind: LedgerAccountKind.USER_AVAILABLE, userId: deposit.userId, asset: LEDGER_ASSET },
      tx,
    );
    const omnibus = await accountFor(
      { kind: LedgerAccountKind.CLIENT_OMNIBUS, asset: token.symbol },
      tx,
    );
    const clientStable = await accountFor(
      { kind: LedgerAccountKind.USER_AVAILABLE, userId: deposit.userId, asset: token.symbol },
      tx,
    );

    /**
     * Two transfers, not one, because USD and the stablecoin are different
     * assets and a single transfer's entries must stay within one — summing
     * dollars and USDC as though fungible is the shortcut that makes a ledger
     * unreadable.
     *
     * First the fiat liability is discharged: the USD FLT owed this participant
     * is closed against the fiat it was holding, exactly as the pre-custody rail
     * did. Then the custodial balance is opened: the stablecoin is in the omnibus
     * and owed to the participant. Together they leave the gateway holding only
     * the fee, the participant owing nothing in USD and holding `net` of the
     * stablecoin.
     */
    await postTransfer(
      {
        kind: LedgerTransferKind.TRADE_SETTLEMENT,
        reference: `fiat-convert-usd:${deposit.id}`,
        memo: `Fiat deposit ${deposit.reference}: closed the USD liability on conversion`,
        createdByAdminId: context.admin.id,
        entries: [
          { accountId: clientUsd.id, amount: net },
          { accountId: gateway.id, amount: net.negated() },
        ],
      },
      tx,
    );

    await postTransfer(
      {
        kind: LedgerTransferKind.TRADE_SETTLEMENT,
        reference: `fiat-convert-${token.symbol.toLowerCase()}:${deposit.id}`,
        memo: `Fiat deposit ${deposit.reference}: ${net.toFixed(2)} ${token.symbol} credited into custody (${deposit.deliveryTxHash})`,
        createdByAdminId: context.admin.id,
        entries: [
          { accountId: omnibus.id, amount: net },
          { accountId: clientStable.id, amount: net.negated() },
        ],
      },
      tx,
    );

    return tx.fiatDeposit.update({
      where: { id: deposit.id },
      data: {
        status: FiatDepositStatus.DELIVERED,
        deliveryAddress: omnibusAddress,
        deliveredAt: new Date(),
        deliveredById: context.admin.id,
      },
    });
  });

  await recordAdminAction(prisma, context, {
    action: 'fiat_deposit.delivered',
    entityType: 'fiat_deposit',
    entityId: deposit.id,
    after: {
      net: net.toFixed(),
      asset: token.symbol,
      omnibus: omnibusAddress,
      txHash: deposit.deliveryTxHash,
      verifiedOnChain: true,
    },
    reason: `Verified ${net.toFixed(2)} ${token.symbol} arrived in the omnibus and credited it`,
  });

  return updated;
}

export async function rejectFiatDeposit(
  context: AdminActionContext,
  input: { depositId: string; note: string },
): Promise<FiatDeposit> {
  assertCan(context.admin, PERMISSIONS.MANAGE_PAYOUTS);

  const deposit = await prisma.fiatDeposit.findUnique({ where: { id: input.depositId } });
  if (!deposit) throw new NotFoundError('Deposit');

  // Only before the money is recorded as received. Once the ledger says FLT
  // owes them, the way out is a refund — a movement with its own record — not
  // a status change that makes the debt disappear.
  if (deposit.status !== FiatDepositStatus.AWAITING_FUNDS) {
    throw new ValidationError(
      'Funds are already recorded as received. Refund it rather than rejecting it, so the ' +
        'money that moved is still accounted for.',
      { status: deposit.status },
    );
  }
  if (!input.note.trim()) {
    throw new ValidationError('Give a reason — the participant is shown it');
  }

  const updated = await prisma.fiatDeposit.update({
    where: { id: deposit.id },
    data: { status: FiatDepositStatus.REJECTED, note: input.note.trim() },
  });

  await recordAdminAction(prisma, context, {
    action: 'fiat_deposit.rejected',
    entityType: 'fiat_deposit',
    entityId: deposit.id,
    after: { status: updated.status },
    reason: input.note.trim(),
  });

  return updated;
}

/**
 * What FLT owes right now on deposits it has taken and not yet delivered.
 *
 * The number an operator should be able to see without asking anyone, and the
 * first thing an auditor asks for.
 */
export async function outstandingFiatLiability(): Promise<{ count: number; usd: string }> {
  const result = await prisma.fiatDeposit.aggregate({
    // SENT counts: a transfer in flight has not arrived, and a figure that
    // drops the moment somebody presses "sent" understates what is owed for
    // exactly as long as the risk lasts.
    where: {
      status: { in: [FiatDepositStatus.FUNDS_RECEIVED, FiatDepositStatus.SENT] },
    },
    _count: true,
    _sum: { netUsd: true },
  });

  return {
    count: result._count,
    usd: new Decimal(result._sum.netUsd?.toString() ?? '0').toFixed(2),
  };
}

/**
 * A short code the participant puts on their transfer.
 *
 * Unambiguous when read aloud or copied off a phone screen: no O/0 or I/1, and
 * short enough to fit a bank reference field that truncates.
 */
function depositReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'FLT-';
  for (let index = 0; index < 8; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
