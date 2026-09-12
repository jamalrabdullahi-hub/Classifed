import {
  RemittanceStatus,
  prisma,
  type RemittanceOrder,
  type User,
} from '@flt/db';
import { getAddress } from 'viem';
import { NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { AuditAction, audit } from './audit';
import { PERMISSIONS, assertCan, recordAdminAction, type AdminActionContext } from './admin';
import { resolveProtectionSettings } from './protection-settings';
import { resolveRemittanceSettings } from './platform-settings';
import { verifyErc20Transfer } from './onchain-payments';

/**
 * Crypto-to-fiat remittance: stablecoin in, EVC Plus payout out.
 *
 * ## This is the one custodial thing FLT does
 *
 * Every other flow here is non-custodial by construction — the participant's
 * key signs, FLT never holds anything. This one cannot be: the participant
 * sends USDC and receives shillings, and between those two events FLT holds
 * their money and owes them a payout. That window is the whole risk of the
 * feature, so it is named (AWAITING_PAYOUT) rather than left implicit, and
 * `outstandingLiability` exists so "what do we owe, and to whom" is one query
 * rather than an audit.
 *
 * ## The legs are deliberately asymmetric
 *
 * Inbound is verified against a mined receipt — token, sender, recipient,
 * amount — through the same checker subscriptions use. Outbound cannot be
 * verified at all, because EVC Plus exposes no merchant API to FLT: an
 * operator sends the money by hand and records a reference. Collapsing both
 * into one "done" flag would let the unverifiable half borrow the credibility
 * of the verified half.
 *
 * ## Why the beneficiary questions are required
 *
 * The money lands on a phone belonging to somebody the platform has never
 * checked. That is the normal case for remittance and also the classic shape
 * of a third-party payment, so the relationship and the purpose are asked:
 * an operator releasing funds is entitled to the sender's own account of who
 * is being paid and why, and a screening decision made without them is a
 * guess. They are stored, not merely displayed.
 */

/** A quote is honoured for this long. Beyond it the FX rate is re-struck. */
const QUOTE_MINUTES = 30;

export interface RemittanceQuote {
  amountUsd: string;
  feeUsd: string;
  netUsd: string;
  fxRate: string;
  payoutAmount: string;
  payoutCurrency: string;
  minUsd: string;
  maxUsd: string;
}

/**
 * Prices a transfer without writing anything.
 *
 * The fee comes off the dollars before conversion, so the participant sees
 * what actually lands rather than a gross figure they have to discount
 * themselves.
 */
export async function quoteRemittance(amountUsd: string): Promise<RemittanceQuote> {
  const settings = await resolveRemittanceSettings();

  if (!settings.enabled) {
    throw new ValidationError('Remittance is not available at the moment.');
  }
  if (!/^\d+(\.\d+)?$/.test(amountUsd)) {
    throw new ValidationError('Enter an amount in dollars');
  }

  const amount = new Decimal(amountUsd);
  if (amount.lessThan(settings.minUsd)) {
    throw new ValidationError(`The minimum transfer is $${settings.minUsd}`);
  }
  if (amount.greaterThan(settings.maxUsd)) {
    throw new ValidationError(`The maximum transfer is $${settings.maxUsd}`);
  }

  const feeUsd = amount
    .times(settings.feeBps)
    .dividedBy(10_000)
    .toDecimalPlaces(2, Decimal.ROUND_UP);
  const netUsd = amount.minus(feeUsd);
  const payout = netUsd.times(settings.fxRate).toDecimalPlaces(2, Decimal.ROUND_DOWN);

  return {
    amountUsd: amount.toFixed(2),
    feeUsd: feeUsd.toFixed(2),
    netUsd: netUsd.toFixed(2),
    fxRate: settings.fxRate,
    payoutAmount: payout.toFixed(2),
    payoutCurrency: settings.currency,
    minUsd: settings.minUsd,
    maxUsd: settings.maxUsd,
  };
}

export interface PreparedRemittance {
  orderId: string;
  quote: RemittanceQuote;
  /** Where to send the stablecoin, and in what. */
  transfer: { to: string; token: string; chainId: number; amountBaseUnits: string };
  expiresAt: Date;
}

export async function createRemittance(
  user: User,
  input: {
    amountUsd: string;
    beneficiaryName: string;
    beneficiaryPhone: string;
    beneficiaryRelationship: string;
    purpose: string;
    walletId: string;
  },
): Promise<PreparedRemittance> {
  const quote = await quoteRemittance(input.amountUsd);

  // Verified identity is not optional on a money-transmission rail, whatever
  // the rest of the platform allows.
  if (user.accountStatus !== 'KYC_APPROVED') {
    throw new ValidationError('Your identity has to be verified before you can send money.');
  }

  const settings = await resolveProtectionSettings();
  const recipient = settings.operatorAddress;
  const tokenAddress = settings.premiumTokenAddress;
  const chainId = settings.premiumChainId;

  if (!recipient || !tokenAddress) {
    throw new ValidationError(
      'Remittance is not configured: the receiving wallet or the stablecoin is not set.',
    );
  }

  const [token, wallet, kyc] = await Promise.all([
    prisma.token.findFirst({ where: { chainId, address: { equals: tokenAddress, mode: 'insensitive' } } }),
    prisma.wallet.findFirst({
      where: { id: input.walletId, userId: user.id, verifiedAt: { not: null } },
    }),
    prisma.kycProfile.findUnique({
      where: { userId: user.id },
      select: { legalFirstName: true, legalLastName: true },
    }),
  ]);

  if (!token) throw new ValidationError('The stablecoin is not in the registry.');
  if (!wallet) throw new ValidationError('Choose a verified wallet to send from.');

  const beneficiaryName = input.beneficiaryName.trim();
  const beneficiaryPhone = normalisePhone(input.beneficiaryPhone);
  const relationship = input.beneficiaryRelationship.trim();
  const purpose = input.purpose.trim();

  if (beneficiaryName.length < 2) throw new ValidationError("Give the recipient's full name");
  if (relationship.length < 2) throw new ValidationError('Say how you know the recipient');
  if (purpose.length < 3) throw new ValidationError('Say what the money is for');

  /**
   * One open transfer at a time.
   *
   * Each open order becomes an unpaid obligation the moment its transfer
   * lands, and the payout is manual. Letting one account stack them turns a
   * queue an operator works through into a backlog they cannot.
   */
  const open = await prisma.remittanceOrder.count({
    where: {
      userId: user.id,
      status: { in: [RemittanceStatus.AWAITING_TRANSFER, RemittanceStatus.AWAITING_PAYOUT] },
    },
  });
  if (open > 0) {
    throw new ValidationError(
      'You already have a transfer in progress. It has to finish before you start another.',
    );
  }

  const amountBaseUnits = BigInt(
    new Decimal(quote.amountUsd)
      .times(new Decimal(10).pow(token.decimals))
      .toDecimalPlaces(0, Decimal.ROUND_UP)
      .toFixed(),
  );

  const expiresAt = new Date(Date.now() + QUOTE_MINUTES * 60_000);

  const order = await prisma.remittanceOrder.create({
    data: {
      id: newId(),
      userId: user.id,
      tokenAddress: tokenAddress.toLowerCase(),
      chainId,
      sendAmount: amountBaseUnits.toString(),
      sendAmountUsd: quote.amountUsd,
      originatorWallet: wallet.address,
      originatorName:
        [kyc?.legalFirstName, kyc?.legalLastName].filter(Boolean).join(' ') || user.email,
      beneficiaryName,
      beneficiaryPhone,
      beneficiaryRelationship: relationship,
      purpose,
      fxRate: quote.fxRate,
      feeUsd: quote.feeUsd,
      payoutAmount: quote.payoutAmount,
      payoutCurrency: quote.payoutCurrency,
      expiresAt,
    },
  });

  await audit(prisma, {
    action: AuditAction.REMITTANCE_CREATED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'remittance_order',
    entityId: order.id,
    after: {
      amountUsd: quote.amountUsd,
      payoutAmount: quote.payoutAmount,
      payoutCurrency: quote.payoutCurrency,
      // Travel Rule: both parties recorded with the transfer itself.
      originator: { name: order.originatorName, account: wallet.address },
      beneficiary: { name: beneficiaryName, account: beneficiaryPhone },
      purpose,
    },
  });

  return {
    orderId: order.id,
    quote,
    transfer: {
      to: getAddress(recipient),
      token: getAddress(tokenAddress),
      chainId,
      amountBaseUnits: amountBaseUnits.toString(),
    },
    expiresAt,
  };
}

/**
 * Moves an order to AWAITING_PAYOUT once its inbound transfer is on-chain.
 *
 * From here FLT owes the beneficiary money. Nothing about this step takes the
 * browser's word: the receipt is fetched and every field checked, and the
 * transaction hash is unique across the table so one transfer can never settle
 * two orders.
 */
export async function confirmRemittanceTransfer(
  user: User,
  orderId: string,
  txHash: string,
): Promise<RemittanceOrder> {
  const order = await prisma.remittanceOrder.findUnique({ where: { id: orderId } });
  if (!order || order.userId !== user.id) throw new NotFoundError('Transfer');

  if (order.status !== RemittanceStatus.AWAITING_TRANSFER) {
    throw new ValidationError('This transfer is not waiting for a payment', {
      status: order.status,
    });
  }

  const alreadyUsed = await prisma.remittanceOrder.findFirst({
    where: { txHash, NOT: { id: order.id } },
  });
  if (alreadyUsed) {
    throw new ValidationError('That transaction has already been used for another transfer');
  }

  const settings = await resolveProtectionSettings();
  const recipient = settings.operatorAddress;
  if (!recipient) throw new ValidationError('No receiving wallet is configured');

  await verifyErc20Transfer({
    chainId: order.chainId,
    txHash,
    tokenAddress: order.tokenAddress,
    from: order.originatorWallet,
    to: recipient,
    expectedBaseUnits: BigInt(order.sendAmount),
  });

  const updated = await prisma.remittanceOrder.update({
    where: { id: order.id },
    data: {
      status: RemittanceStatus.AWAITING_PAYOUT,
      txHash,
      verifiedAt: new Date(),
    },
  });

  await audit(prisma, {
    action: AuditAction.REMITTANCE_FUNDED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'remittance_order',
    entityId: order.id,
    after: { txHash, amountUsd: order.sendAmountUsd },
  });

  return updated;
}

export async function listRemittancesForUser(userId: string): Promise<RemittanceOrder[]> {
  return prisma.remittanceOrder.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
}

/** The payout queue. Oldest first — FLT already holds this money. */
export async function listRemittancesForPayout(
  status: RemittanceStatus = RemittanceStatus.AWAITING_PAYOUT,
) {
  return prisma.remittanceOrder.findMany({
    where: { status },
    orderBy: { createdAt: status === RemittanceStatus.AWAITING_PAYOUT ? 'asc' : 'desc' },
    take: 100,
    include: { user: { select: { id: true, email: true, accountStatus: true } } },
  });
}

/**
 * What FLT currently owes, in dollars and in the payout currency.
 *
 * One query rather than a reconciliation exercise. An operator opening the
 * queue is looking at money that has already left somebody's wallet, and this
 * total is what says whether the EVC float can cover it.
 */
export async function outstandingLiability(): Promise<{
  count: number;
  usd: string;
  payout: string;
  currency: string;
}> {
  const [orders, settings] = await Promise.all([
    prisma.remittanceOrder.findMany({
      where: { status: RemittanceStatus.AWAITING_PAYOUT },
      select: { sendAmountUsd: true, payoutAmount: true, payoutCurrency: true },
    }),
    resolveRemittanceSettings(),
  ]);

  const usd = orders.reduce((total, order) => total.plus(order.sendAmountUsd), new Decimal(0));
  const payout = orders.reduce((total, order) => total.plus(order.payoutAmount), new Decimal(0));

  return {
    count: orders.length,
    usd: usd.toFixed(2),
    payout: payout.toFixed(2),
    currency: orders[0]?.payoutCurrency ?? settings.currency,
  };
}

export async function markRemittancePaid(
  context: AdminActionContext,
  input: { orderId: string; reference: string },
): Promise<RemittanceOrder> {
  assertCan(context.admin, PERMISSIONS.MANAGE_PAYOUTS);

  const order = await prisma.remittanceOrder.findUnique({ where: { id: input.orderId } });
  if (!order) throw new NotFoundError('Transfer');

  if (order.status !== RemittanceStatus.AWAITING_PAYOUT) {
    throw new ValidationError('This transfer is not awaiting payout', { status: order.status });
  }
  // The EVC reference is the only evidence this leg produces. Without it there
  // is nothing to reconcile the payout against later.
  if (!input.reference.trim()) {
    throw new ValidationError('Record the EVC transaction reference for this payout');
  }

  const updated = await prisma.remittanceOrder.update({
    where: { id: order.id },
    data: {
      status: RemittanceStatus.PAID,
      payoutReference: input.reference.trim(),
      paidAt: new Date(),
      paidByAdminId: context.admin.id,
    },
  });

  await recordAdminAction(prisma, context, {
    action: AuditAction.REMITTANCE_PAID,
    entityType: 'remittance_order',
    entityId: order.id,
    before: { status: order.status },
    after: {
      status: updated.status,
      payoutAmount: order.payoutAmount,
      payoutCurrency: order.payoutCurrency,
      beneficiary: { name: order.beneficiaryName, account: order.beneficiaryPhone },
    },
    reason: input.reference.trim(),
  });

  return updated;
}

/**
 * Holds a transfer for a closer look without pretending it is not owed.
 *
 * Deliberately not a status change: a held order is still AWAITING_PAYOUT and
 * still counts toward the outstanding liability, because FLT has the money
 * either way. A hold that quietly removed it from what is owed would make the
 * one number that matters wrong.
 */
export async function holdRemittance(
  context: AdminActionContext,
  input: { orderId: string; reason: string },
): Promise<RemittanceOrder> {
  assertCan(context.admin, PERMISSIONS.MANAGE_PAYOUTS);
  if (!input.reason.trim()) throw new ValidationError('Give a reason for the hold');

  const updated = await prisma.remittanceOrder.update({
    where: { id: input.orderId },
    data: { heldAt: new Date(), heldReason: input.reason.trim() },
  });

  await recordAdminAction(prisma, context, {
    action: AuditAction.REMITTANCE_HELD,
    entityType: 'remittance_order',
    entityId: input.orderId,
    after: { held: true },
    reason: input.reason.trim(),
  });

  return updated;
}

/**
 * Refuses a transfer.
 *
 * Note what this does *not* do: it does not return the crypto. If the inbound
 * leg has already been verified then FLT is holding the participant's money,
 * and refusing the payout leaves a debt to be settled outside this system. The
 * refusal records that explicitly, so the obligation is documented rather than
 * quietly closed.
 */
export async function rejectRemittance(
  context: AdminActionContext,
  input: { orderId: string; reason: string },
): Promise<RemittanceOrder> {
  assertCan(context.admin, PERMISSIONS.MANAGE_PAYOUTS);
  if (!input.reason.trim()) throw new ValidationError('Give a reason — the sender is shown it');

  const order = await prisma.remittanceOrder.findUnique({ where: { id: input.orderId } });
  if (!order) throw new NotFoundError('Transfer');
  if (order.status === RemittanceStatus.PAID) {
    throw new ValidationError('This transfer has already been paid out');
  }

  const updated = await prisma.remittanceOrder.update({
    where: { id: order.id },
    data: { status: RemittanceStatus.REJECTED, reviewNote: input.reason.trim() },
  });

  await recordAdminAction(prisma, context, {
    action: AuditAction.REMITTANCE_REJECTED,
    entityType: 'remittance_order',
    entityId: order.id,
    before: { status: order.status },
    after: {
      status: updated.status,
      // Stated rather than inferred: a rejection after funding is a debt, not
      // a closure.
      fundsHeldByFlt: order.status === RemittanceStatus.AWAITING_PAYOUT,
    },
    reason: input.reason.trim(),
  });

  return updated;
}

/** Digits and a leading "+", kept as given so it matches an EVC statement by eye. */
function normalisePhone(value: string): string {
  const cleaned = value.trim().replace(/[^\d+]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new ValidationError('That does not look like a phone number');
  }
  return cleaned;
}
