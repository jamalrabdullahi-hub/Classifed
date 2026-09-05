import { Decimal } from '../domain/money';
import { ForbiddenError, ValidationError } from '../domain/errors';
import type { DbClient } from '../server/db';

/**
 * Trading and withdrawal limits by KYC tier.
 *
 * PLACEHOLDER VALUES. The real numbers are a compliance decision — they depend
 * on Somali regulatory thresholds and on the brokerage's own risk appetite,
 * neither of which is inferable from code. See src/providers/kyc/README.md.
 *
 * The mechanism is real and enforced; only the numbers are provisional.
 */

export interface TierLimits {
  tier: number;
  label: string;
  /** Rolling 24-hour cap on the USD value a customer may trade. */
  dailyTradeUsd: Decimal;
  /** Rolling 24-hour cap on the USD-equivalent value a customer may withdraw. */
  dailyWithdrawalUsd: Decimal;
  /** Largest single order. */
  maxSingleTradeUsd: Decimal;
  canTrade: boolean;
  canWithdraw: boolean;
}

const TIERS: TierLimits[] = [
  {
    tier: 0,
    label: 'Unverified',
    dailyTradeUsd: new Decimal(0),
    dailyWithdrawalUsd: new Decimal(0),
    maxSingleTradeUsd: new Decimal(0),
    canTrade: false,
    canWithdraw: false,
  },
  {
    tier: 1,
    label: 'Verified',
    dailyTradeUsd: new Decimal(2_000),
    dailyWithdrawalUsd: new Decimal(2_000),
    maxSingleTradeUsd: new Decimal(1_000),
    canTrade: true,
    canWithdraw: true,
  },
  {
    tier: 2,
    label: 'Enhanced',
    dailyTradeUsd: new Decimal(20_000),
    dailyWithdrawalUsd: new Decimal(20_000),
    maxSingleTradeUsd: new Decimal(10_000),
    canTrade: true,
    canWithdraw: true,
  },
];

export function limitsForTier(tier: number): TierLimits {
  // Unknown tiers fall back to the most restrictive, never the most permissive.
  return TIERS.find((t) => t.tier === tier) ?? TIERS[0]!;
}

export interface CustomerStanding {
  userId: string;
  tier: number;
  limits: TierLimits;
  kycStatus: string;
}

export async function getCustomerStanding(
  db: DbClient,
  userId: string,
): Promise<CustomerStanding> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true, kycProfile: { select: { status: true, tier: true } } },
  });
  if (!user) throw new ForbiddenError('Unknown customer');
  if (user.status !== 'ACTIVE') {
    throw new ForbiddenError(`Account is ${user.status.toLowerCase()}`);
  }

  const kycStatus = user.kycProfile?.status ?? 'NOT_STARTED';
  const tier = kycStatus === 'APPROVED' ? (user.kycProfile?.tier ?? 0) : 0;

  return { userId, tier, limits: limitsForTier(tier), kycStatus };
}

export function assertCanTrade(standing: CustomerStanding): void {
  if (!standing.limits.canTrade) {
    throw new ForbiddenError(
      standing.kycStatus === 'APPROVED'
        ? 'Your account tier does not permit trading'
        : 'Complete identity verification before trading',
    );
  }
}

export function assertCanWithdraw(standing: CustomerStanding): void {
  if (!standing.limits.canWithdraw) {
    throw new ForbiddenError(
      standing.kycStatus === 'APPROVED'
        ? 'Your account tier does not permit withdrawals'
        : 'Complete identity verification before withdrawing',
    );
  }
}

/**
 * Rolling 24-hour USD traded, computed from orders rather than from a counter,
 * so it cannot drift out of step with what actually happened.
 */
export async function tradedUsdLast24h(db: DbClient, userId: string): Promise<Decimal> {
  const rows = await db.$queryRaw<{ total: string | null }[]>`
    SELECT COALESCE(SUM("requestedFiatAmount"), 0)::text AS total
    FROM "orders"
    WHERE "userId" = ${userId}
      AND "createdAt" > NOW() - INTERVAL '24 hours'
      AND "status" NOT IN ('FAILED', 'CANCELLED', 'REFUNDED')
  `;
  return new Decimal(rows[0]?.total ?? '0');
}

export async function withdrawnUsdLast24h(db: DbClient, userId: string): Promise<Decimal> {
  // Crypto withdrawals are counted at the USD value recorded on the withdrawal,
  // which the withdrawal service stamps at request time.
  const rows = await db.$queryRaw<{ total: string | null }[]>`
    SELECT COALESCE(SUM(("metadata"->>'usdValue')::numeric), 0)::text AS total
    FROM "ledger_transactions"
    WHERE "type" IN ('CRYPTO_WITHDRAWAL', 'USD_WITHDRAWAL')
      AND "occurredAt" > NOW() - INTERVAL '24 hours'
      AND "metadata"->>'userId' = ${userId}
  `;
  return new Decimal(rows[0]?.total ?? '0');
}

export async function assertWithinTradeLimits(
  db: DbClient,
  standing: CustomerStanding,
  usdAmount: Decimal,
): Promise<void> {
  assertCanTrade(standing);

  if (usdAmount.gt(standing.limits.maxSingleTradeUsd)) {
    throw new ValidationError(
      `Single order limit for ${standing.limits.label} accounts is $${standing.limits.maxSingleTradeUsd.toFixed(2)}`,
      { limit: standing.limits.maxSingleTradeUsd.toFixed(2) },
    );
  }

  const used = await tradedUsdLast24h(db, standing.userId);
  if (used.plus(usdAmount).gt(standing.limits.dailyTradeUsd)) {
    throw new ValidationError(
      `This order would exceed your 24-hour trading limit of $${standing.limits.dailyTradeUsd.toFixed(2)}`,
      {
        limit: standing.limits.dailyTradeUsd.toFixed(2),
        used: used.toFixed(2),
      },
    );
  }
}

export async function assertWithinWithdrawalLimits(
  db: DbClient,
  standing: CustomerStanding,
  usdValue: Decimal,
): Promise<void> {
  assertCanWithdraw(standing);

  const used = await withdrawnUsdLast24h(db, standing.userId);
  if (used.plus(usdValue).gt(standing.limits.dailyWithdrawalUsd)) {
    throw new ValidationError(
      `This withdrawal would exceed your 24-hour limit of $${standing.limits.dailyWithdrawalUsd.toFixed(2)}`,
      {
        limit: standing.limits.dailyWithdrawalUsd.toFixed(2),
        used: used.toFixed(2),
      },
    );
  }
}

export { TIERS };
