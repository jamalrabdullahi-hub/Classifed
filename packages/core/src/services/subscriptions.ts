import { encodeFunctionData, erc20Abi, getAddress, parseEventLogs } from 'viem';
import {
  SubscriptionStatus,
  SubscriptionTier,
  prisma,
  type Subscription,
  type SubscriptionPlan,
  type User,
} from '@flt/db';
import { env } from '@flt/config';
import { NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { publicClient } from '../chains/client';
import { AuditAction, audit } from './audit';
import { activeTier } from './entitlements';

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

  const config = env();
  const plan = await prisma.subscriptionPlan.findUnique({ where: { tier } });

  if (!plan || !plan.isAvailable) throw new NotFoundError('Plan');

  const recipient = config.FLT_FEE_RECIPIENT_ADDRESS;
  const tokenAddress = config.PROTECTION_PREMIUM_TOKEN_ADDRESS;

  if (!recipient || !tokenAddress) {
    throw new ValidationError(
      'Subscriptions cannot be bought yet: the payment token or recipient is not configured.',
    );
  }

  const token = await prisma.token.findFirst({
    where: { chainId: config.PROTECTION_PREMIUM_CHAIN_ID, address: tokenAddress.toLowerCase() },
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
      chainId: config.PROTECTION_PREMIUM_CHAIN_ID,
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
      chainId: config.PROTECTION_PREMIUM_CHAIN_ID,
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

  const config = env();
  const recipient = config.FLT_FEE_RECIPIENT_ADDRESS;
  if (!recipient) throw new ValidationError('No payment recipient is configured');

  const expected = BigInt(
    new Decimal(subscription.pricePaidUsd)
      .times(new Decimal(10).pow(token.decimals))
      .toDecimalPlaces(0, Decimal.ROUND_UP)
      .toFixed(),
  );

  const receipt = await publicClient(subscription.chainId).getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });

  if (receipt.status !== 'success') {
    throw new ValidationError('That transaction reverted on-chain', { txHash });
  }

  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs });

  const match = transfers.find(
    (log) =>
      log.address.toLowerCase() === subscription.tokenAddress!.toLowerCase() &&
      log.args.from.toLowerCase() === wallet.address.toLowerCase() &&
      log.args.to.toLowerCase() === recipient.toLowerCase() &&
      log.args.value >= expected,
  );

  if (!match) {
    throw new ValidationError(
      'That transaction does not contain the payment this plan requires. The token, recipient, ' +
        'sender and amount all have to match.',
      { txHash, expected: expected.toString() },
    );
  }

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
