import { encodeFunctionData, erc20Abi, getAddress } from 'viem';
import {
  ReferralEarningKind,
  SubscriptionStatus,
  SubscriptionTier,
  prisma,
  type Subscription,
  type SubscriptionPlan,
  type User,
} from '@flt/db';
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { AuditAction, audit } from './audit';
import { activeTier } from './entitlements';
import { recordReferralEarning } from './referrals';
import { resolveProtectionSettings } from './protection-settings';
import { verifyErc20Transfer } from './onchain-payments';
import { PERMISSIONS, assertCan, recordAdminAction, type AdminActionContext } from './admin';

/**
 * Buying a subscription.
 *
 * ## Paid per period, never pulled
 *
 * There is no auto-renewal, and that is a consequence of the architecture
 * rather than a missing feature: renewing on the participant's behalf would
 * need either custody of their funds or a standing allowance plus a server-side
 * key to spend it. FLT has neither and is not going to acquire one to save
 * somebody a click. A period is bought, it runs, and it is bought again.
 *
 * ## Activated by a verified transfer, not by a claim
 *
 * The row is written PENDING_PAYMENT and entitlements do not apply. It becomes
 * ACTIVE only once the transfer is found in a mined receipt with the right
 * token, sender, recipient and amount. A browser saying "I paid" is a claim.
 *
 * ## An upgrade is a new period, not a proration
 *
 * Prorating a mid-period upgrade means computing a credit, which means holding
 * a balance, which is custody again. Instead an upgrade starts a fresh period
 * and the remaining days of the old plan are added to it — the participant is
 * never worse off, and no money is held.
 */

/** One period. Thirty days rather than a calendar month, so every period is equal. */
const PERIOD_DAYS = 30;

export interface PreparedSubscription {
  subscriptionId: string;
  plan: SubscriptionPlan;
  /** What is charged, in the premium token's own units. */
  priceUsd: string;
  amountBaseUnits: string;
  transfer: {
    to: string;
    token: string;
    chainId: number;
    data: `0x${string}`;
    description: string;
  };
  /** Days carried over from a plan being replaced mid-period. */
  carriedOverDays: number;
  note: string;
}

export async function listPlans(): Promise<SubscriptionPlan[]> {
  const plans = await prisma.subscriptionPlan.findMany({ where: { isAvailable: true } });

  // Ordered by price rather than by enum position, so a repriced ladder still
  // reads low to high on the pricing page.
  return plans.sort((a, b) => new Decimal(a.priceUsd).comparedTo(new Decimal(b.priceUsd)));
}

/**
 * Writes the subscription as unpaid and returns the transfer that activates it.
 */
export async function prepareSubscription(
  user: User,
  tier: SubscriptionTier,
): Promise<PreparedSubscription> {
  if (tier === SubscriptionTier.FREE) {
    throw new ValidationError('The free tier is what you have when nothing is active.');
  }

  const plan = await prisma.subscriptionPlan.findUnique({ where: { tier } });

  if (!plan || !plan.isAvailable) throw new NotFoundError('Plan');

  /**
   * Where the money goes, resolved rather than read straight from the
   * environment.
   *
   * This used to read `env()` directly, which meant an operator could set the
   * fee wallet and payment token in the admin panel, see them stored, and
   * still have every checkout refuse with "not configured" — the panel wrote
   * to the database and this read past it. `resolveProtectionSettings` is the
   * one place that decides the effective value, and it still falls back to the
   * environment when nothing is stored.
   */
  const settings = await resolveProtectionSettings();
  const recipient = settings.operatorAddress;
  const tokenAddress = settings.premiumTokenAddress;
  const chainId = settings.premiumChainId;

  if (!recipient || !tokenAddress) {
    throw new ValidationError(
      'Subscriptions cannot be bought yet: the payment token or the receiving wallet is not ' +
        'set. An operator sets both under Protection in the admin panel.',
    );
  }

  const token = await prisma.token.findFirst({
    where: { chainId, address: tokenAddress.toLowerCase() },
  });
  if (!token) {
    throw new ValidationError(
      'The payment token is not in the registry, so its decimals cannot be resolved.',
    );
  }

  // Days left on whatever is running now, carried into the new period so an
  // upgrade never costs somebody the time they already paid for.
  const current = await prisma.subscription.findFirst({
    where: {
      userId: user.id,
      status: SubscriptionStatus.ACTIVE,
      endsAt: { gt: new Date() },
    },
    orderBy: { endsAt: 'desc' },
  });

  const carriedOverDays = current?.endsAt
    ? Math.max(0, Math.ceil((current.endsAt.getTime() - Date.now()) / 86_400_000))
    : 0;

  const amount = BigInt(
    new Decimal(plan.priceUsd)
      .times(new Decimal(10).pow(token.decimals))
      .toDecimalPlaces(0, Decimal.ROUND_UP)
      .toFixed(),
  );

  const subscription = await prisma.subscription.create({
    data: {
      id: newId(),
      userId: user.id,
      tier,
      status: SubscriptionStatus.PENDING_PAYMENT,
      pricePaidUsd: plan.priceUsd,
      tokenAddress: tokenAddress.toLowerCase(),
      chainId,
    },
  });

  return {
    subscriptionId: subscription.id,
    plan,
    priceUsd: plan.priceUsd,
    amountBaseUnits: amount.toString(),
    transfer: {
      to: getAddress(recipient),
      token: getAddress(tokenAddress),
      chainId,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [getAddress(recipient), amount],
      }),
      description: `${plan.name} — ${PERIOD_DAYS} days`,
    },
    carriedOverDays,
    note:
      `Sign the transfer from your own wallet. ${plan.name} runs for ${PERIOD_DAYS} days` +
      (carriedOverDays > 0
        ? `, plus the ${carriedOverDays} day${carriedOverDays === 1 ? '' : 's'} left on your current plan.`
        : '.') +
      ' There is no auto-renewal — FLT holds no key that could charge you again.',
  };
}

/**
 * Activates a subscription once its payment is verified on-chain.
 *
 * Every field is checked against the receipt: the token contract, the sender,
 * the recipient and the amount. Anything less would let a plan be activated by
 * a one-cent transfer, or by an unrelated token, or by somebody else's payment.
 */
export async function confirmSubscription(
  subscriptionId: string,
  actor: User,
  txHash: string,
): Promise<Subscription> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new ValidationError('That is not a transaction hash', { txHash });
  }

  const subscription = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!subscription || subscription.userId !== actor.id) throw new NotFoundError('Subscription');

  if (subscription.status !== SubscriptionStatus.PENDING_PAYMENT) {
    throw new ValidationError('This subscription is not awaiting payment', {
      status: subscription.status,
    });
  }
  if (!subscription.chainId || !subscription.tokenAddress || !subscription.pricePaidUsd) {
    throw new ValidationError('This subscription was not created as a purchase');
  }

  // The same hash must not activate two subscriptions.
  const alreadyUsed = await prisma.subscription.findFirst({
    where: { txHash, NOT: { id: subscription.id } },
  });
  if (alreadyUsed) {
    throw new ValidationError('That transaction has already been used for a subscription.');
  }

  const [wallet, token] = await Promise.all([
    prisma.wallet.findFirst({
      where: { userId: actor.id, verifiedAt: { not: null } },
    }),
    prisma.token.findFirst({
      where: { chainId: subscription.chainId, address: subscription.tokenAddress },
    }),
  ]);

  if (!wallet) throw new ValidationError('No verified wallet on this account');
  if (!token) throw new ValidationError('The payment token is no longer in the registry');

  // Resolved the same way `prepareSubscription` resolved it. Reading the
  // environment here while the quote came from the stored settings would
  // reject every legitimate payment: the transfer would land at the address
  // the participant was told to pay, and be checked against a different one.
  const recipient = (await resolveProtectionSettings()).operatorAddress;
  if (!recipient) throw new ValidationError('No payment recipient is configured');

  const expected = BigInt(
    new Decimal(subscription.pricePaidUsd)
      .times(new Decimal(10).pow(token.decimals))
      .toDecimalPlaces(0, Decimal.ROUND_UP)
      .toFixed(),
  );

  // The whole check — token, sender, recipient and amount against the mined
  // receipt — lives in one place shared with remittance, so the two payment
  // rails cannot drift into checking different things.
  await verifyErc20Transfer({
    chainId: subscription.chainId,
    txHash,
    tokenAddress: subscription.tokenAddress,
    from: wallet.address,
    to: recipient,
    expectedBaseUnits: expected,
  });

  const now = new Date();

  const activated = await prisma.$transaction(async (tx) => {
    // Whatever was running is superseded, and its remaining days are added to
    // the new period rather than discarded.
    const previous = await tx.subscription.findFirst({
      where: { userId: actor.id, status: SubscriptionStatus.ACTIVE, endsAt: { gt: now } },
      orderBy: { endsAt: 'desc' },
    });

    const carriedMs = previous?.endsAt ? Math.max(0, previous.endsAt.getTime() - now.getTime()) : 0;

    if (previous) {
      await tx.subscription.update({
        where: { id: previous.id },
        data: {
          status: SubscriptionStatus.CANCELLED,
          cancelledAt: now,
          cancelReason: 'Replaced by a new plan; remaining time carried over',
        },
      });
    }

    return tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: SubscriptionStatus.ACTIVE,
        startsAt: now,
        endsAt: new Date(now.getTime() + PERIOD_DAYS * 86_400_000 + carriedMs),
        txHash,
        paidAt: now,
      },
    });
  });

  // The referrer's share of this payment. Recorded after activation so a
  // failure here can never cost somebody the plan they just paid for.
  await recordReferralEarning(prisma, {
    userId: actor.id,
    kind: ReferralEarningKind.SUBSCRIPTION,
    grossAmount: subscription.pricePaidUsd,
    subscriptionId: subscription.id,
    tokenAddress: subscription.tokenAddress,
    chainId: subscription.chainId,
    currency: 'USD',
  });

  await audit(prisma, {
    action: AuditAction.SUBSCRIPTION_ACTIVATED,
    actorType: 'USER',
    actorUserId: actor.id,
    entityType: 'subscription',
    entityId: subscription.id,
    after: {
      tier: subscription.tier,
      pricePaidUsd: subscription.pricePaidUsd,
      endsAt: activated.endsAt,
      txHash,
    },
  });

  return activated;
}

/**
 * Grants a subscription period without a payment — an operator override, not
 * a purchase.
 *
 * Everything upstream of this function still applies: `entitlementsFor`
 * cannot tell a granted period from a paid one, because it is the same
 * ACTIVE row with the same tier and `endsAt`. What's different is
 * `pricePaidUsd`/`txHash`/`paidAt` staying null and the audit entry
 * recording which admin granted it and why — this is the one path in the
 * whole subscriptions module that does not require a verified on-chain
 * transfer, so it exists as its own function rather than a flag on
 * `confirmSubscription`, where a caller could reach for it by accident.
 */
export async function grantSubscription(
  context: AdminActionContext,
  input: { targetUserId: string; tier: SubscriptionTier; days: number; reason: string },
): Promise<Subscription> {
  assertCan(context.admin, PERMISSIONS.MANAGE_SUBSCRIPTIONS);

  if (input.tier === SubscriptionTier.FREE) {
    throw new ValidationError('FREE is the default; there is nothing to grant.');
  }
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 3650) {
    throw new ValidationError('Grant length must be between 1 and 3650 days');
  }

  const now = new Date();

  const granted = await prisma.$transaction(async (tx) => {
    const previous = await tx.subscription.findFirst({
      where: { userId: input.targetUserId, status: SubscriptionStatus.ACTIVE, endsAt: { gt: now } },
      orderBy: { endsAt: 'desc' },
    });

    if (previous) {
      await tx.subscription.update({
        where: { id: previous.id },
        data: {
          status: SubscriptionStatus.CANCELLED,
          cancelledAt: now,
          cancelReason: `Replaced by an operator grant: ${input.reason}`,
        },
      });
    }

    return tx.subscription.create({
      data: {
        id: newId(),
        userId: input.targetUserId,
        tier: input.tier,
        status: SubscriptionStatus.ACTIVE,
        startsAt: now,
        endsAt: new Date(now.getTime() + input.days * 86_400_000),
      },
    });
  });

  await recordAdminAction(prisma, context, {
    action: AuditAction.SUBSCRIPTION_ACTIVATED,
    entityType: 'subscription',
    entityId: granted.id,
    after: { tier: input.tier, days: input.days, endsAt: granted.endsAt, granted: true },
    reason: input.reason,
  });

  return granted;
}

/** Ends a subscription early. The period is not refunded — no balance is held. */
export async function cancelSubscription(
  subscriptionId: string,
  actor: User,
): Promise<Subscription> {
  const subscription = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!subscription || subscription.userId !== actor.id) throw new NotFoundError('Subscription');

  if (subscription.status !== SubscriptionStatus.ACTIVE) {
    throw new ValidationError('Only an active subscription can be cancelled');
  }

  const cancelled = await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      status: SubscriptionStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelReason: 'Cancelled by the participant',
    },
  });

  await audit(prisma, {
    action: AuditAction.SUBSCRIPTION_CANCELLED,
    actorType: 'USER',
    actorUserId: actor.id,
    entityType: 'subscription',
    entityId: subscription.id,
  });

  return cancelled;
}

/**
 * Marks lapsed subscriptions EXPIRED.
 *
 * Housekeeping only: `activeTier` already refuses a period that has run out, so
 * a late sweep can never extend anybody's plan. This keeps the table honest for
 * anyone reading it.
 */
export async function expireLapsed(): Promise<number> {
  const result = await prisma.subscription.updateMany({
    where: { status: SubscriptionStatus.ACTIVE, endsAt: { lt: new Date() } },
    data: { status: SubscriptionStatus.EXPIRED },
  });

  return result.count;
}

/** What the participant currently has, for the account page. */
export async function currentSubscription(userId: string): Promise<{
  tier: SubscriptionTier;
  expiresAt: Date | null;
  subscription: Subscription | null;
}> {
  const { tier, expiresAt } = await activeTier(prisma, userId);

  const subscription = await prisma.subscription.findFirst({
    where: { userId, status: SubscriptionStatus.ACTIVE },
    orderBy: { endsAt: 'desc' },
  });

  return { tier, expiresAt, subscription };
}


// ── Operator ────────────────────────────────────────────────────────────────

export interface UpdatePlanInput {
  tier: SubscriptionTier;
  name?: string;
  tagline?: string;
  priceUsd?: string;
  isFeatured?: boolean;
  isAvailable?: boolean;
  feeDiscountBps?: number;
  maxLeverage?: number;
  watchlistLimit?: number | null;
  priceAlertLimit?: number | null;
  historyDays?: number | null;
  advancedOrderTools?: boolean;
  fullIndicators?: boolean;
  advancedRiskAnalytics?: boolean;
  advancedProtectionAnalytics?: boolean;
  fundingAnalytics?: boolean;
  advancedPnl?: boolean;
  fullPnl?: boolean;
  apiAccess?: boolean;
  priorityData?: boolean;
  prioritySupport?: boolean;
  reason: string;
}

/**
 * Repricing a plan.
 *
 * Changes the definition, never anybody's running subscription: a participant
 * paid for what was advertised when they paid, and a price change must not
 * rewrite that. `Subscription.pricePaidUsd` records what was actually charged
 * for exactly this reason.
 *
 * Guards refuse rather than clamp. An operator typing 15000 basis points of
 * discount should be told it is impossible, not have it silently saved and then
 * quietly capped the first time somebody trades.
 */
export async function updatePlan(
  admin: { id: string; role: string },
  input: UpdatePlanInput,
): Promise<SubscriptionPlan> {
  if (admin.role !== 'SUPER_ADMIN') {
    throw new ForbiddenError('Only a super admin may change plan pricing');
  }
  if (!input.reason?.trim()) {
    throw new ValidationError('A reason is required for this change');
  }
  if (input.tier === SubscriptionTier.FREE && input.priceUsd && input.priceUsd !== '0') {
    throw new ValidationError('The free tier cannot have a price');
  }

  if (input.priceUsd !== undefined) {
    if (!/^\d+(\.\d{1,2})?$/.test(input.priceUsd)) {
      throw new ValidationError('Price must be a dollar amount with at most two decimals', {
        priceUsd: input.priceUsd,
      });
    }
  }
  if (input.feeDiscountBps !== undefined) {
    if (
      !Number.isInteger(input.feeDiscountBps) ||
      input.feeDiscountBps < 0 ||
      input.feeDiscountBps > 10_000
    ) {
      throw new ValidationError(
        'The fee discount must be a whole number of basis points between 0 and 10000 ' +
          '(10000 would make trading free).',
        { feeDiscountBps: input.feeDiscountBps },
      );
    }
  }
  if (input.maxLeverage !== undefined) {
    if (!Number.isInteger(input.maxLeverage) || input.maxLeverage < 1 || input.maxLeverage > 100) {
      throw new ValidationError('Leverage must be a whole number between 1 and 100', {
        maxLeverage: input.maxLeverage,
      });
    }
  }

  const previous = await prisma.subscriptionPlan.findUnique({ where: { tier: input.tier } });
  if (!previous) throw new NotFoundError('Plan');

  const { tier, reason, ...changes } = input;

  const updated = await prisma.$transaction(async (tx) => {
    // Exactly one plan is featured, or the pricing page has no default. Setting
    // one unsets the others rather than leaving the operator to notice.
    if (changes.isFeatured === true) {
      await tx.subscriptionPlan.updateMany({
        where: { NOT: { tier } },
        data: { isFeatured: false },
      });
    }

    return tx.subscriptionPlan.update({
      where: { tier },
      data: { ...changes, updatedById: admin.id },
    });
  });

  await audit(prisma, {
    action: AuditAction.ADMIN_PLAN_CHANGED,
    actorType: 'ADMIN',
    actorAdminId: admin.id,
    entityType: 'subscription_plan',
    entityId: tier,
    before: {
      name: previous.name,
      priceUsd: previous.priceUsd,
      feeDiscountBps: previous.feeDiscountBps,
      maxLeverage: previous.maxLeverage,
      isAvailable: previous.isAvailable,
    },
    after: {
      name: updated.name,
      priceUsd: updated.priceUsd,
      feeDiscountBps: updated.feeDiscountBps,
      maxLeverage: updated.maxLeverage,
      isAvailable: updated.isAvailable,
      reason,
    },
  });

  return updated;
}

/** Every plan with a count of who is on it, for the operator view. */
export async function planSummary(): Promise<
  Array<SubscriptionPlan & { activeCount: number }>
> {
  const [plans, counts] = await Promise.all([
    prisma.subscriptionPlan.findMany(),
    prisma.subscription.groupBy({
      by: ['tier'],
      where: { status: SubscriptionStatus.ACTIVE, endsAt: { gt: new Date() } },
      _count: true,
    }),
  ]);

  const byTier = new Map(counts.map((row) => [row.tier, row._count]));

  return plans
    .sort((a, b) => new Decimal(a.priceUsd).comparedTo(new Decimal(b.priceUsd)))
    .map((plan) => ({ ...plan, activeCount: byTier.get(plan.tier) ?? 0 }));
}
