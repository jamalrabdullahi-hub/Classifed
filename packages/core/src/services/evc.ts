import {
  EvcPaymentStatus,
  SubscriptionTier,
  prisma,
  type EvcPayment,
  type User,
} from '@flt/db';
import { NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { PERMISSIONS, assertCan, recordAdminAction, type AdminActionContext } from './admin';
import { evcUssdCode, resolveEvcSettings } from './platform-settings';
import { grantSubscription } from './subscriptions';

/**
 * Buying a plan with EVC Plus.
 *
 * ## This rail cannot verify anything, and says so everywhere
 *
 * The on-chain rail in `subscriptions.ts` activates a plan against a mined
 * receipt: the token, sender, recipient and amount are all checked, and a
 * browser claiming payment counts for nothing. EVC Plus gives FLT no
 * equivalent — there is no merchant API here — so this rail is honest about
 * what it is: the participant dials a USSD string on their own handset, then
 * *tells* us they did, and an operator reconciles that against the merchant
 * statement before anything is granted.
 *
 * Everything below is shaped by that one fact. The record is called a claim,
 * it starts AWAITING_REVIEW, it confers nothing, and the only path from claim
 * to entitlement runs through `confirmEvcPayment` — which is itself just the
 * ordinary operator grant, so an EVC purchase produces the same subscription
 * row and the same audit trail as a manual grant. There is deliberately no
 * "auto-confirm after N minutes" and no participant-supplied reference that
 * the system treats as proof.
 */

/** One period, matching the on-chain rail so the two cannot drift apart. */
const PERIOD_DAYS = 30;

/**
 * How many claims one account may leave open.
 *
 * Each open claim is a piece of operator work, so an account that can create
 * them without limit can bury the review queue. Two is enough for an honest
 * mistake (wrong amount, retried) and not enough to be useful as a nuisance.
 */
const MAX_OPEN_CLAIMS = 2;

export interface PreparedEvcPayment {
  paymentId: string;
  tier: SubscriptionTier;
  planName: string;
  amountUsd: string;
  merchantNumber: string;
  /** Exactly what to dial. Rendered for reading, not for a tel: link. */
  ussdCode: string;
  days: number;
}

/**
 * Records the claim and returns the dial string.
 *
 * Note the order: the row is written *before* the code is shown. A
 * participant who dials and then closes the tab has still left a record an
 * operator can find and honour — the alternative loses their money.
 */
export async function createEvcPayment(
  user: User,
  input: { tier: SubscriptionTier; payerName: string; payerPhone: string },
): Promise<PreparedEvcPayment> {
  const settings = await resolveEvcSettings();
  if (!settings.enabled) {
    throw new ValidationError('EVC Plus payment is not available at the moment.');
  }

  if (input.tier === SubscriptionTier.FREE) {
    throw new ValidationError('The free tier is what you have when nothing is active.');
  }

  const plan = await prisma.subscriptionPlan.findUnique({ where: { tier: input.tier } });
  if (!plan || !plan.isAvailable) throw new NotFoundError('Plan');

  const payerName = input.payerName.trim();
  const payerPhone = normalisePhone(input.payerPhone);

  if (payerName.length < 2) {
    throw new ValidationError('Give the name on the paying account, as EVC has it');
  }

  const open = await prisma.evcPayment.count({
    where: { userId: user.id, status: EvcPaymentStatus.AWAITING_REVIEW },
  });
  if (open >= MAX_OPEN_CLAIMS) {
    throw new ValidationError(
      'You already have payments waiting to be checked. They will be reviewed shortly — ' +
        'please do not send again until then.',
    );
  }

  // Two decimal places, because that is what the dial string carries. Rounding
  // up rather than down: a claim for less than the price would be reconciled
  // as a short payment and rejected, which costs the participant a round trip.
  const amountUsd = new Decimal(plan.priceUsd).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed(2);

  const payment = await prisma.evcPayment.create({
    data: {
      id: newId(),
      userId: user.id,
      tier: input.tier,
      days: PERIOD_DAYS,
      amountUsd,
      payerName,
      payerPhone,
      merchantNumber: settings.merchantNumber,
    },
  });

  return {
    paymentId: payment.id,
    tier: plan.tier,
    planName: plan.name,
    amountUsd,
    merchantNumber: settings.merchantNumber,
    ussdCode: evcUssdCode(settings.merchantNumber, amountUsd),
    days: PERIOD_DAYS,
  };
}

/** This account's own claims, newest first. */
export async function listEvcPaymentsForUser(userId: string): Promise<EvcPayment[]> {
  return prisma.evcPayment.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
}

/** The operator review queue. Oldest first — the person waiting longest is served first. */
export async function listEvcPaymentsForReview(
  status: EvcPaymentStatus = EvcPaymentStatus.AWAITING_REVIEW,
) {
  return prisma.evcPayment.findMany({
    where: { status },
    orderBy: { createdAt: status === EvcPaymentStatus.AWAITING_REVIEW ? 'asc' : 'desc' },
    take: 100,
    include: { user: { select: { id: true, email: true, accountStatus: true } } },
  });
}

/**
 * Confirms a claim against the merchant statement and grants the plan.
 *
 * The grant goes through `grantSubscription` rather than writing a
 * subscription row here, so there is exactly one code path that turns an
 * operator's decision into an entitlement, and it is the audited one.
 */
export async function confirmEvcPayment(
  context: AdminActionContext,
  input: { paymentId: string; note: string },
): Promise<EvcPayment> {
  assertCan(context.admin, PERMISSIONS.MANAGE_SUBSCRIPTIONS);

  const payment = await prisma.evcPayment.findUnique({ where: { id: input.paymentId } });
  if (!payment) throw new NotFoundError('Payment');

  if (payment.status !== EvcPaymentStatus.AWAITING_REVIEW) {
    throw new ValidationError('This payment has already been reviewed', {
      status: payment.status,
    });
  }
  if (!input.note.trim()) {
    throw new ValidationError(
      'Say which statement line this matches. "Confirmed" with no reference is not reconciliation.',
    );
  }

  const granted = await grantSubscription(context, {
    targetUserId: payment.userId,
    tier: payment.tier,
    days: payment.days,
    reason: `EVC Plus payment ${payment.id} confirmed: ${input.note.trim()}`,
  });

  const updated = await prisma.evcPayment.update({
    where: { id: payment.id },
    data: {
      status: EvcPaymentStatus.CONFIRMED,
      subscriptionId: granted.id,
      reviewedAt: new Date(),
      reviewedById: context.admin.id,
      reviewNote: input.note.trim(),
    },
  });

  await recordAdminAction(prisma, context, {
    action: 'evc_payment.confirmed',
    entityType: 'evc_payment',
    entityId: payment.id,
    before: { status: payment.status },
    after: { status: updated.status, subscriptionId: granted.id, tier: payment.tier },
    reason: input.note.trim(),
  });

  return updated;
}

export async function rejectEvcPayment(
  context: AdminActionContext,
  input: { paymentId: string; note: string },
): Promise<EvcPayment> {
  assertCan(context.admin, PERMISSIONS.MANAGE_SUBSCRIPTIONS);

  const payment = await prisma.evcPayment.findUnique({ where: { id: input.paymentId } });
  if (!payment) throw new NotFoundError('Payment');

  if (payment.status !== EvcPaymentStatus.AWAITING_REVIEW) {
    throw new ValidationError('This payment has already been reviewed', {
      status: payment.status,
    });
  }
  // A rejection is somebody being told their money did not arrive. They are
  // owed a reason they can act on, so it is required rather than optional.
  if (!input.note.trim()) {
    throw new ValidationError('Give a reason — the participant is shown it');
  }

  const updated = await prisma.evcPayment.update({
    where: { id: payment.id },
    data: {
      status: EvcPaymentStatus.REJECTED,
      reviewedAt: new Date(),
      reviewedById: context.admin.id,
      reviewNote: input.note.trim(),
    },
  });

  await recordAdminAction(prisma, context, {
    action: 'evc_payment.rejected',
    entityType: 'evc_payment',
    entityId: payment.id,
    before: { status: payment.status },
    after: { status: updated.status },
    reason: input.note.trim(),
  });

  return updated;
}

/**
 * Keeps the digits and a leading "+".
 *
 * Not parsed into a canonical international form: an operator matches this
 * against a telco statement by eye, and a number rewritten into a shape the
 * statement does not use makes that harder, not easier.
 */
function normalisePhone(value: string): string {
  const cleaned = value.trim().replace(/[^\d+]/g, '');
  const digits = cleaned.replace(/\D/g, '');

  if (digits.length < 7 || digits.length > 15) {
    throw new ValidationError('That does not look like a phone number');
  }
  return cleaned;
}
