import { z } from 'zod';
import {
  issueReferralCode,
  redeemReferralCode,
  referralSummary,
} from '@flt/core/services/referrals';
import { RateLimits } from '@flt/core/services/ratelimit';
import { handler } from '@/server/api';

/**
 * Referrals.
 *
 * GET  the caller's code, how many have used it, and what they have earned.
 * POST issue a code — idempotent, so a double click cannot make two.
 * PUT  redeem somebody else's code.
 *
 * Redemption is rate limited. A code is eight characters from a 31-symbol
 * alphabet, which is not brute-forceable at any sane rate, but the endpoint
 * also reveals whether a code exists — and an unlimited oracle for that would
 * let somebody enumerate active referrers.
 */
export const GET = handler({}, async ({ user }) => {
  const summary = await referralSummary(user.id);

  return {
    code: summary.code?.code ?? null,
    isActive: summary.code?.isActive ?? false,
    referredCount: summary.referredCount,
    accrued: summary.accrued,
    paid: summary.paid,
    referredBy: summary.referredBy,
    terms: {
      shareBps: summary.shareBps,
      grantDays: summary.grantDays,
      grantTier: summary.grantTier,
    },
  };
});

export const POST = handler({}, async ({ user }) => {
  const code = await issueReferralCode(user);
  return { code: code.code, isActive: code.isActive };
});

export const PUT = handler(
  {
    schema: z.object({ code: z.string().trim().min(1).max(32) }),
    rateLimit: { rule: RateLimits.QUOTE, scope: 'referral-redeem' },
  },
  async ({ user, body }) => {
    const result = await redeemReferralCode(user, body.code);

    return {
      tier: result.tier,
      grantedUntil: result.grantedUntil,
      note:
        'Redeemed. Your free month is active now — it will not renew, and nothing was charged.',
    };
  },
);
