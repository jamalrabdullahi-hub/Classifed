import { randomBytes } from 'node:crypto';
import {
  ReferralEarningKind,
  ReferralEarningStatus,
  SubscriptionStatus,
  SubscriptionTier,
  prisma,
  type DbClient,
  type Referral,
  type ReferralCode,
  type User,
} from '@flt/db';
import { NotFoundError, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { Decimal } from '../domain/money';
import { AuditAction, audit } from './audit';

/**
 * Referrals.
 *
 * ## One level, deliberately
 *
 * A referrer earns a share of FLT's revenue from the people they bring, and
 * nothing from the people *those* people bring. That is the whole structure.
 * A second level would make the returns depend on recruiting recruiters rather
 * than on bringing traders, which is the thing this is not, and the cleanest
 * way to guarantee it is for the schema to have nowhere to put it —
 * `Referral` records a referrer and a referred and has no parent.
 *
 * ## Referred once, ever
 *
 * `Referral.referredUserId` is unique across the whole table. Without that,
 * somebody could redeem a second code when the first free month lapsed and keep
 * doing it, and the free tier would be permanent for anyone patient enough to
 * collect codes.
 *
 * ## Earnings are recorded, not held
 *
 * Every share is a row naming the trade or payment that produced it, so a
 * balance can always be itemised. FLT holds no float — an accrued earning is
 * money owed, not money sitting somewhere — and payout is a deliberate act
 * rather than an automatic transfer this system has no key to make.
 */

/** The referrer's share of FLT revenue, in basis points. 2000 = 20%. */
export const REFERRAL_SHARE_BPS = 2_000;

/** What a redeemed code grants, and for how long. */
export const REFERRAL_GRANT_TIER = SubscriptionTier.BASIC;
export const REFERRAL_GRANT_DAYS = 30;

/**
 * Unambiguous when spoken or typed.
 *
 * No 0/O, no 1/I/L. A code gets read off a stream, retyped from a screenshot
 * and pasted from a chat message, and every one of those is a chance for a
 * character that looks like another to send somebody to a code that does not
 * exist — or, worse, to one that does and belongs to somebody else.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return code;
}

/**
 * Issues the caller's referral code, or returns the one they already have.
 *
 * Idempotent, because the interface offers this as a single button and a double
 * click must not produce a second code — and because `userId` is unique on the
 * table, a race would otherwise surface as a constraint error rather than as
 * the code the user asked for.
 */
export async function issueReferralCode(user: User): Promise<ReferralCode> {
  const existing = await prisma.referralCode.findUnique({ where: { userId: user.id } });
  if (existing) return existing;

  /**
   * A verified wallet is the only requirement.
   *
   * Not KYC: posting a code is not trading, and gating it on approval would put
   * a compliance queue between somebody and a link they want to share. A wallet
   * is required because that is where a payout would eventually go, and issuing
   * codes to accounts with nowhere to pay is how a program accrues obligations
   * it cannot settle.
   */
  const wallet = await prisma.wallet.findFirst({
    where: { userId: user.id, verifiedAt: { not: null } },
  });

  if (!wallet) {
    throw new ValidationError(
      'Connect and verify a wallet first — that is where referral earnings are paid.',
    );
  }

  // Retried rather than assumed unique: the alphabet is deliberately small for
  // legibility, so a collision is unlikely but not impossible.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateCode();
    const taken = await prisma.referralCode.findUnique({ where: { code } });
    if (taken) continue;

    const created = await prisma.referralCode.create({
      data: { id: newId(), userId: user.id, code },
    });

    await audit(prisma, {
      action: AuditAction.REFERRAL_CODE_ISSUED,
      actorType: 'USER',
      actorUserId: user.id,
      entityType: 'referral_code',
      entityId: created.id,
      after: { code },
    });

    return created;
  }

  throw new ValidationError('Could not allocate a referral code. Try again.');
}

export interface RedeemResult {
  referral: Referral;
  grantedUntil: Date;
  tier: SubscriptionTier;
}

/**
 * Redeems a code, granting the free period.
 *
 * Everything that could make this unfair is refused rather than tolerated:
 * redeeming your own code, redeeming twice, and redeeming while already paying
 * for a plan — the last because the grant would silently replace something
 * somebody bought.
 */
export async function redeemReferralCode(user: User, rawCode: string): Promise<RedeemResult> {
  const code = rawCode.trim().toUpperCase();
  if (!code) throw new ValidationError('Enter a referral code');

  const referralCode = await prisma.referralCode.findUnique({ where: { code } });
  if (!referralCode || !referralCode.isActive) {
    throw new NotFoundError('Referral code');
  }

  if (referralCode.userId === user.id) {
    throw new ValidationError('You cannot redeem your own code.');
  }

  const alreadyReferred = await prisma.referral.findUnique({
    where: { referredUserId: user.id },
  });
  if (alreadyReferred) {
    throw new ValidationError('This account has already used a referral code.');
  }

  const activePlan = await prisma.subscription.findFirst({
    where: {
      userId: user.id,
      status: SubscriptionStatus.ACTIVE,
      endsAt: { gt: new Date() },
    },
  });
  if (activePlan) {
    throw new ValidationError(
      'You already have an active plan. Redeem a code once it ends, so the free month is not ' +
        'spent replacing something you paid for.',
    );
  }

  const now = new Date();
  const grantedUntil = new Date(now.getTime() + REFERRAL_GRANT_DAYS * 86_400_000);

  const referral = await prisma.$transaction(async (tx) => {
    const subscription = await tx.subscription.create({
      data: {
        id: newId(),
        userId: user.id,
        tier: REFERRAL_GRANT_TIER,
        // Active immediately: this one was not bought, so there is no payment
        // to verify. `pricePaidUsd` of zero records that honestly rather than
        // leaving a null that reads as missing data.
        status: SubscriptionStatus.ACTIVE,
        startsAt: now,
        endsAt: grantedUntil,
        pricePaidUsd: '0',
        paidAt: now,
      },
    });

    return tx.referral.create({
      data: {
        id: newId(),
        codeId: referralCode.id,
        referrerUserId: referralCode.userId,
        referredUserId: user.id,
        grantedSubscriptionId: subscription.id,
      },
    });
  });

  await audit(prisma, {
    action: AuditAction.REFERRAL_REDEEMED,
    actorType: 'USER',
    actorUserId: user.id,
    entityType: 'referral',
    entityId: referral.id,
    after: {
      code,
      referrerUserId: referralCode.userId,
      grantedTier: REFERRAL_GRANT_TIER,
      grantedUntil,
    },
  });

  return { referral, grantedUntil, tier: REFERRAL_GRANT_TIER };
}

/**
 * Records the referrer's share of one piece of revenue.
 *
 * Called wherever FLT actually earns. A no-op for anybody who was not referred,
 * which is the common case, so it is written to be cheap and to never throw
 * into the path that produced the revenue: failing a subscription payment
 * because an earning row would not write is the wrong trade.
 */
export async function recordReferralEarning(
  db: DbClient,
  input: {
    userId: string;
    kind: ReferralEarningKind;
    /** The revenue FLT received, in whatever it was received in. */
    grossAmount: string;
    tokenAddress?: string | null;
    chainId?: number | null;
    currency?: string | null;
    subscriptionId?: string | null;
    quoteId?: string | null;
  },
): Promise<void> {
  try {
    const referral = await db.referral.findUnique({ where: { referredUserId: input.userId } });
    if (!referral) return;

    const gross = new Decimal(input.grossAmount);
    if (!gross.isFinite() || gross.lessThanOrEqualTo(0)) return;

    const amount = gross.times(REFERRAL_SHARE_BPS).dividedBy(10_000);

    await db.referralEarning.create({
      data: {
        id: newId(),
        referralId: referral.id,
        referrerUserId: referral.referrerUserId,
        kind: input.kind,
        status: ReferralEarningStatus.ACCRUED,
        grossAmount: gross.toFixed(),
        shareBps: REFERRAL_SHARE_BPS,
        amount: amount.toFixed(),
        tokenAddress: input.tokenAddress ?? null,
        chainId: input.chainId ?? null,
        currency: input.currency ?? null,
        subscriptionId: input.subscriptionId ?? null,
        quoteId: input.quoteId ?? null,
      },
    });
  } catch (error) {
    // Loud, but not propagated. A missing earning row is recoverable from the
    // subscription and quote tables; a failed payment because of one is not.
    console.error('[referrals] failed to record earning', {
      userId: input.userId,
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface ReferralSummary {
  code: ReferralCode | null;
  /** How many people have redeemed it. */
  referredCount: number;
  /** Accrued earnings grouped by what they are denominated in. */
  accrued: Array<{ currency: string; amount: string; count: number }>;
  paid: Array<{ currency: string; amount: string; count: number }>;
  /** The referral this account itself came from, if any. */
  referredBy: { code: string; redeemedAt: Date } | null;
  shareBps: number;
  grantDays: number;
  grantTier: SubscriptionTier;
}

export async function referralSummary(userId: string): Promise<ReferralSummary> {
  const [code, referredCount, earnings, referredBy] = await Promise.all([
    prisma.referralCode.findUnique({ where: { userId } }),
    prisma.referral.count({ where: { referrerUserId: userId } }),
    prisma.referralEarning.findMany({ where: { referrerUserId: userId } }),
    prisma.referral.findUnique({
      where: { referredUserId: userId },
      include: { code: { select: { code: true } } },
    }),
  ]);

  /**
   * Grouped by denomination rather than summed.
   *
   * A trading-fee share is taken in whatever token was traded, so adding them
   * together would produce a number with no unit. Better several honest totals
   * than one meaningless one.
   */
  function group(status: ReferralEarningStatus) {
    const totals = new Map<string, { amount: Decimal; count: number }>();

    for (const earning of earnings) {
      if (earning.status !== status) continue;
      const key = earning.currency ?? earning.tokenAddress ?? 'unknown';
      const current = totals.get(key) ?? { amount: new Decimal(0), count: 0 };
      totals.set(key, {
        amount: current.amount.plus(earning.amount),
        count: current.count + 1,
      });
    }

    return [...totals].map(([currency, total]) => ({
      currency,
      amount: total.amount.toFixed(),
      count: total.count,
    }));
  }

  return {
    code,
    referredCount,
    accrued: group(ReferralEarningStatus.ACCRUED),
    paid: group(ReferralEarningStatus.PAID),
    referredBy: referredBy
      ? { code: referredBy.code.code, redeemedAt: referredBy.redeemedAt }
      : null,
    shareBps: REFERRAL_SHARE_BPS,
    grantDays: REFERRAL_GRANT_DAYS,
    grantTier: REFERRAL_GRANT_TIER,
  };
}
