import { SubscriptionTier, prisma } from '@flt/db';

/**
 * The published subscription ladder.
 *
 * Seeded rather than hardcoded: price, limits and the fee discount are
 * commercial decisions that change without a deploy, and the admin panel edits
 * these rows. This script writes the launch values and is safe to re-run — it
 * updates the plan definition but never touches anybody's subscription.
 *
 * ## What each tier is actually for
 *
 * The tiers are deliberately different in kind, not just in quantity. Basic
 * gets somebody through the door; Pro is the one an active trader shrugs at;
 * Elite is for the volume that makes a fee discount worth more than the
 * subscription costs.
 *
 * ## The fee discount is the real product
 *
 * 10% off at Pro and 25% off at Elite, applied to the trading fee rather than
 * to notional. That makes the pitch arithmetic rather than persuasion: at 25
 * bps, Elite pays for itself at roughly $32,000 of monthly volume, and a trader
 * who does that much knows it.
 *
 * ## Protection is not on this ladder
 *
 * Cover is never gated. The tiers sell software; a protection contribution is a
 * separate economic relationship with a participants' pool, and tangling the two
 * would make the subscription look like an insurance premium. Only the
 * analytics differ — the basic calculation stays free to everyone.
 */
const PLANS = [
  {
    tier: SubscriptionTier.FREE,
    name: 'Free',
    tagline: 'Spot trading and the basics.',
    priceUsd: '0',
    isFeatured: false,
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
    /**
     * Two.
     *
     * Past 2x an ordinary day's move can liquidate a position, so this is where
     * the commercial gate and a genuine risk boundary happen to coincide. An
     * account that has never paid anything has also never been asked to think
     * about that.
     */
    maxLeverage: 2,
  },
  {
    tier: SubscriptionTier.BASIC,
    name: 'FLT Basic',
    tagline: 'For the occasional trader.',
    priceUsd: '4.99',
    isFeatured: false,
    // No discount: Basic buys access and tools, not cheaper trading. The
    // discount is what makes Pro and Elite worth stepping up to.
    feeDiscountBps: 0,
    watchlistLimit: 5,
    priceAlertLimit: 10,
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
    /**
     * Ten.
     *
     * Note this only means ten where the platform allows it: PERP_MAX_LEVERAGE
     * is a hard ceiling over every plan, so on a deployment capped at 10x this
     * makes Basic, Pro and Elite identical on leverage and the ladder stops
     * differentiating there. Raise the platform cap if the tiers are meant to
     * differ by leverage.
     */
    maxLeverage: 10,
  },
  {
    tier: SubscriptionTier.PRO,
    name: 'FLT Pro',
    tagline: 'For traders who are in the market every day.',
    priceUsd: '9.99',
    // The default choice on the pricing page.
    isFeatured: true,
    feeDiscountBps: 1_000,
    watchlistLimit: 25,
    priceAlertLimit: 50,
    historyDays: 365,
    advancedOrderTools: true,
    fullIndicators: true,
    advancedRiskAnalytics: true,
    advancedProtectionAnalytics: true,
    fundingAnalytics: true,
    advancedPnl: true,
    fullPnl: false,
    apiAccess: false,
    priorityData: true,
    prioritySupport: false,
    maxLeverage: 20,
  },
  {
    tier: SubscriptionTier.ELITE,
    name: 'FLT Elite',
    tagline: 'For heavy users and anyone trading through the API.',
    priceUsd: '19.99',
    isFeatured: false,
    feeDiscountBps: 2_500,
    // Null is unlimited.
    watchlistLimit: null,
    priceAlertLimit: null,
    historyDays: null,
    advancedOrderTools: true,
    fullIndicators: true,
    advancedRiskAnalytics: true,
    advancedProtectionAnalytics: true,
    fundingAnalytics: true,
    advancedPnl: true,
    fullPnl: true,
    apiAccess: true,
    priorityData: true,
    prioritySupport: true,
    maxLeverage: 50,
  },
];

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  for (const plan of PLANS) {
    const existing = await prisma.subscriptionPlan.findUnique({ where: { tier: plan.tier } });

    if (existing && !force) {
      // An operator may have repriced this in the admin panel, and a seed that
      // silently reverted that would be worse than one that skipped.
      console.info(
        `${plan.tier.padEnd(6)} already configured at $${existing.priceUsd} — left alone ` +
          '(use --force to overwrite)',
      );
      continue;
    }

    await prisma.subscriptionPlan.upsert({
      where: { tier: plan.tier },
      create: { ...plan, isAvailable: true },
      update: { ...plan, isAvailable: true },
    });

    console.info(
      `${plan.tier.padEnd(6)} $${plan.priceUsd.padEnd(6)} ` +
        `${String(plan.feeDiscountBps / 100).padStart(4)}% off fees   ` +
        `up to ${plan.maxLeverage}x`,
    );
  }

  const featured = await prisma.subscriptionPlan.count({ where: { isFeatured: true } });
  if (featured !== 1) {
    console.warn(
      `\nWarning: ${featured} plans are marked featured. Exactly one should be, or the ` +
        'pricing page has no default.',
    );
  }
}

main()
  .catch((error) => {
    console.error('FAILED:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
