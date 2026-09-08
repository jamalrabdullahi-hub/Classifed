import {
  SubscriptionStatus,
  SubscriptionTier,
  prisma,
  type DbClient,
  type SubscriptionPlan,
} from '@flt/db';
import { env } from '@flt/config';
import { ForbiddenError } from '../domain/errors';

/**
 * What an account is allowed to do.
 *
 * One module answers that question, and everything else asks it. The
 * alternative — each feature checking a tier itself — produces a system where
 * nobody can say what a plan actually includes without grepping, and where a
 * new tier means editing thirty call sites.
 *
 * ## The free tier is a row, not a null
 *
 * An account with no subscription gets the FREE plan rather than a pile of
 * special cases. Every limit and flag therefore has exactly one source, and
 * "what does a free account get" is a question the database answers.
 *
 * ## Entitlements follow payment, not intent
 *
 * A subscription is ACTIVE only once its payment has been verified on-chain and
 * only until `endsAt`. There is no auto-renewal: FLT holds no key that could
 * pull from a participant's wallet, so a period is bought and then bought
 * again. A lapsed plan silently degrades to FREE rather than blocking the
 * account — the trader keeps their positions and their data, they just lose the
 * tools.
 *
 * ## What is deliberately never gated
 *
 * Protection itself. The tiers sell software; the protection contribution is a
 * separate economic relationship with a participants' pool, and putting cover
 * behind a paywall would entangle the two. Only the *analytics* differ by tier
 * — the basic calculation is free to everyone.
 */

export interface Entitlements {
  tier: SubscriptionTier;
  planName: string;
  /** When the current period ends. Null on FREE. */
  expiresAt: Date | null;

  /** Reduction on the trading fee, in basis points OF THE FEE. */
  feeDiscountBps: number;

  /** Null means unlimited. */
  watchlistLimit: number | null;
  priceAlertLimit: number | null;
  historyDays: number | null;

  advancedOrderTools: boolean;
  fullIndicators: boolean;
  advancedRiskAnalytics: boolean;
  advancedProtectionAnalytics: boolean;
  fundingAnalytics: boolean;
  advancedPnl: boolean;
  fullPnl: boolean;
  apiAccess: boolean;
  priorityData: boolean;
  prioritySupport: boolean;

  /** The highest leverage this account may use, after every cap is applied. */
  maxLeverage: number;

  /**
   * Opening trades allowed per day. Null is unlimited.
   *
   * Openings only. Closing is never limited — a cap that could trap somebody in
   * a leveraged position is a hazard, not a pricing lever.
   */
  dailyTradeLimit: number | null;
  /** Whether this account may trade perpetuals at all. */
  perpsAccess: boolean;
  /** Whether this account may enable the AI trading agent. */
  agenticTradingAccess: boolean;
}

/**
 * The fallback when no plan row exists yet.
 *
 * A deployment that has not seeded its plans should behave like a free tier
 * rather than throw on every page. Deliberately mean: it grants nothing, so a
 * missing row can never accidentally hand out a paid feature.
 */
const FREE_FALLBACK: Omit<Entitlements, 'tier' | 'planName' | 'expiresAt'> = {
  feeDiscountBps: 0,
  watchlistLimit: 3,
  priceAlertLimit: 3,
  historyDays: 30,
  advancedOrderTools: false,
  fullIndicators: false,
  advancedRiskAnalytics: false,
  advancedProtectionAnalytics: false,
  fundingAnalytics: false,
  advancedPnl: false,
  fullPnl: false,
  apiAccess: false,
  priorityData: false,
  prioritySupport: false,
  maxLeverage: 2,
  dailyTradeLimit: 10,
  perpsAccess: false,
  agenticTradingAccess: false,
};

/** The tier a user is currently entitled to, ignoring what they have bought before. */
export async function activeTier(
  db: DbClient,
  userId: string,
): Promise<{ tier: SubscriptionTier; expiresAt: Date | null }> {
  const subscription = await db.subscription.findFirst({
    where: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      // A period that has run out is not active however the row is marked. The
      // worker sweeps these to EXPIRED, but the check must not depend on the
      // sweep having run — a late cron must never extend a plan.
      OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
    },
    orderBy: { endsAt: 'desc' },
  });

  if (!subscription) return { tier: SubscriptionTier.FREE, expiresAt: null };
  return { tier: subscription.tier, expiresAt: subscription.endsAt };
}

export async function entitlementsFor(userId: string, db: DbClient = prisma): Promise<Entitlements> {
  const { tier, expiresAt } = await activeTier(db, userId);
  const plan = await db.subscriptionPlan.findUnique({ where: { tier } });

  return fromPlan(tier, plan, expiresAt);
}

/** Shapes a plan row into entitlements, applying the platform's own ceilings. */
export function fromPlan(
  tier: SubscriptionTier,
  plan: SubscriptionPlan | null,
  expiresAt: Date | null,
): Entitlements {
  const config = env();

  if (!plan) {
    return {
      tier,
      planName: tier === SubscriptionTier.FREE ? 'Free' : tier,
      expiresAt,
      ...FREE_FALLBACK,
      maxLeverage: Math.min(FREE_FALLBACK.maxLeverage, config.PERP_MAX_LEVERAGE),
    };
  }

  return {
    tier,
    planName: plan.name,
    expiresAt,
    feeDiscountBps: plan.feeDiscountBps,
    watchlistLimit: plan.watchlistLimit,
    priceAlertLimit: plan.priceAlertLimit,
    historyDays: plan.historyDays,
    advancedOrderTools: plan.advancedOrderTools,
    fullIndicators: plan.fullIndicators,
    advancedRiskAnalytics: plan.advancedRiskAnalytics,
    advancedProtectionAnalytics: plan.advancedProtectionAnalytics,
    fundingAnalytics: plan.fundingAnalytics,
    advancedPnl: plan.advancedPnl,
    fullPnl: plan.fullPnl,
    apiAccess: plan.apiAccess,
    priorityData: plan.priorityData,
    prioritySupport: plan.prioritySupport,
    dailyTradeLimit: plan.dailyTradeLimit,
    perpsAccess: plan.perpsAccess,
    agenticTradingAccess: plan.agenticTradingAccess,
    // The plan is one ceiling among several; the platform's own cap and the
    // venue's still apply, and the lowest always wins.
    maxLeverage: Math.min(plan.maxLeverage, config.PERP_MAX_LEVERAGE),
  };
}

// ── Gates ───────────────────────────────────────────────────────────────────

export type GatedFeature = Extract<
  keyof Entitlements,
  | 'advancedOrderTools'
  | 'fullIndicators'
  | 'advancedRiskAnalytics'
  | 'advancedProtectionAnalytics'
  | 'fundingAnalytics'
  | 'advancedPnl'
  | 'fullPnl'
  | 'apiAccess'
  | 'priorityData'
  | 'prioritySupport'
>;

const FEATURE_LABELS: Record<GatedFeature, string> = {
  advancedOrderTools: 'Advanced order tools',
  fullIndicators: 'The full indicator set',
  advancedRiskAnalytics: 'Advanced risk analytics',
  advancedProtectionAnalytics: 'Advanced protection analytics',
  fundingAnalytics: 'Funding-rate analytics',
  advancedPnl: 'Advanced P&L analytics',
  fullPnl: 'Full P&L analytics',
  apiAccess: 'API access',
  priorityData: 'Priority data',
  prioritySupport: 'Priority support',
};

export function has(entitlements: Entitlements, feature: GatedFeature): boolean {
  return entitlements[feature] === true;
}

/**
 * Refuses a feature the account has not paid for.
 *
 * The message names the feature and says a plan is needed, and deliberately
 * does not name a price — pricing lives in the database and a hardcoded figure
 * here would go stale the first time it changed.
 */
export function assertHas(entitlements: Entitlements, feature: GatedFeature): void {
  if (has(entitlements, feature)) return;
  // ForbiddenError carries only a message, so the message has to be the whole
  // explanation: what was refused, and implicitly that a plan would fix it.
  throw new ForbiddenError(
    `${FEATURE_LABELS[feature]} is not included in your ${entitlements.planName} plan.`,
  );
}

/**
 * Whether a limit permits one more of something.
 *
 * Null is unlimited. Compared as `current < limit` so a limit of 5 permits five
 * items and refuses the sixth — off-by-one here is the difference between an
 * advertised limit and a lie.
 */
export function withinLimit(limit: number | null, current: number): boolean {
  if (limit === null) return true;
  return current < limit;
}

export function assertWithinLimit(
  limit: number | null,
  current: number,
  what: string,
): void {
  if (withinLimit(limit, current)) return;
  throw new ForbiddenError(
    `Your plan includes ${limit} ${what}. Upgrade to add more, or remove one first.`,
  );
}

/**
 * The leverage this account may actually use.
 *
 * Four ceilings, and the lowest wins: the venue's, FLT's own configured cap,
 * the subscription's, and — where protection is required — the waterfall bound
 * that keeps insurance resolving before the margin call. This function applies
 * the first three; the waterfall is applied where volatility is known.
 */
export function maxLeverageFor(entitlements: Entitlements, venueMax: number): number {
  return Math.max(1, Math.min(entitlements.maxLeverage, venueMax));
}

export function assertLeverageAllowed(entitlements: Entitlements, leverage: number): void {
  if (leverage <= entitlements.maxLeverage) return;

  throw new ForbiddenError(
    `Your ${entitlements.planName} plan allows up to ${entitlements.maxLeverage}x. ` +
      `Trading at ${leverage}x needs a higher plan.`,
  );
}

// ── Fees ────────────────────────────────────────────────────────────────────

/**
 * Applies a plan's discount to a trading fee.
 *
 * The discount is a proportion **of the fee**, not of notional. 25% off a 25 bps
 * fee is 18.75 bps, not 25 bps minus 25% of the trade — the second reading would
 * pay the trader to trade and is the kind of mistake that only shows up in the
 * ledger.
 *
 * Rounded down, so the discount is never smaller than advertised.
 */
export function applyFeeDiscount(bps: number, discountBps: number): number {
  if (discountBps <= 0) return bps;
  const capped = Math.min(discountBps, 10_000);
  return Math.floor((bps * (10_000 - capped)) / 10_000);
}


// ── Perpetuals and trade frequency ──────────────────────────────────────────

/**
 * Refuses perpetuals to a tier that does not include them.
 *
 * Free accounts get spot. Leverage is where an ordinary day's move can end a
 * position, and gating it is where the commercial line and a real risk boundary
 * happen to fall together.
 */
export function assertPerpsAllowed(entitlements: Entitlements): void {
  if (entitlements.perpsAccess) return;

  throw new ForbiddenError(
    `Perpetuals are not included in your ${entitlements.planName} plan. ` +
      'Spot trading is available on every account.',
  );
}

/**
 * Refuses an opening trade once the daily allowance is spent.
 *
 * Only openings count, and the message says so — somebody who has hit the limit
 * needs to know immediately that they can still close what they hold, because
 * the alternative is a person who believes they are locked into a position.
 */
export function assertDailyTradesRemaining(
  entitlements: Entitlements,
  openedToday: number,
): void {
  if (entitlements.dailyTradeLimit === null) return;
  if (openedToday < entitlements.dailyTradeLimit) return;

  throw new ForbiddenError(
    `Your ${entitlements.planName} plan allows ${entitlements.dailyTradeLimit} new positions a ` +
      'day and you have used them. You can still close or reduce anything you hold — that is ' +
      'never limited. The allowance resets at midnight UTC.',
  );
}

/** Opening trades since midnight UTC. Closes are excluded by the caller. */
export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
