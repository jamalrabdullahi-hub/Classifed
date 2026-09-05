import { prisma } from '@flt/db';
import { RateLimitedError } from '../domain/errors.js';
import { newId } from '../domain/id.js';
import { Decimal } from '../domain/money.js';

/**
 * Token-bucket rate limiting, backed by Postgres.
 *
 * Postgres rather than Redis because this system already depends on Postgres,
 * and adding a second datastore for one feature is not worth the operational
 * cost at this scale. The interface is narrow enough that swapping in Redis
 * later is a one-file change.
 *
 * Refill and consume happen in a single statement, so two concurrent requests
 * cannot both observe a full bucket.
 */

export interface RateLimitRule {
  /** Bucket capacity — the largest burst permitted. */
  capacity: number;
  /** Tokens restored per second. */
  refillPerSecond: number;
}

export const RateLimits = {
  /** Brute-force protection. Deliberately tight. */
  LOGIN: { capacity: 5, refillPerSecond: 5 / 300 },
  REGISTER: { capacity: 3, refillPerSecond: 3 / 3_600 },
  PASSWORD_RESET: { capacity: 3, refillPerSecond: 3 / 900 },
  /** A wrong TOTP code is cheap to retry; make it expensive. */
  MFA_CHALLENGE: { capacity: 6, refillPerSecond: 6 / 300 },
  EMAIL_RESEND: { capacity: 3, refillPerSecond: 3 / 600 },

  /** Indicative prices are requested as the user types. Allow a working pace. */
  PRICE: { capacity: 60, refillPerSecond: 2 },
  /** Firm quotes cost an upstream API call each. */
  QUOTE: { capacity: 20, refillPerSecond: 0.5 },
  TRADE_SUBMIT: { capacity: 10, refillPerSecond: 10 / 60 },
  WALLET_LINK: { capacity: 10, refillPerSecond: 10 / 300 },

  API_GENERAL: { capacity: 120, refillPerSecond: 2 },
  ADMIN_GENERAL: { capacity: 240, refillPerSecond: 4 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Consumes one token from `key`'s bucket.
 *
 * Returns rather than throws, so a caller can choose to degrade instead of
 * reject. Use `enforceRateLimit` for the common reject-with-429 case.
 */
export async function consumeToken(
  key: string,
  rule: RateLimitRule,
  cost = 1,
): Promise<RateLimitResult> {
  const rows = await prisma.$queryRaw<{ tokens: string }[]>`
    INSERT INTO "rate_limit_buckets" ("id", "key", "tokens", "createdAt", "updatedAt")
    VALUES (${newId()}, ${key}, ${rule.capacity - cost}::numeric, NOW(), NOW())
    ON CONFLICT ("key") DO UPDATE
      SET "tokens" = LEAST(
            ${rule.capacity}::numeric,
            "rate_limit_buckets"."tokens"
              + EXTRACT(EPOCH FROM (NOW() - "rate_limit_buckets"."updatedAt"))
                * ${rule.refillPerSecond}::numeric
          ) - ${cost}::numeric,
          "updatedAt" = NOW()
    RETURNING "tokens"::text AS "tokens"
  `;

  const tokens = new Decimal(rows[0]?.tokens ?? '0');

  if (tokens.isNegative()) {
    // Overdrawn. Restore the token we could not take, so a rejected request
    // does not deepen the debt and extend the lockout indefinitely.
    await prisma.$executeRaw`
      UPDATE "rate_limit_buckets"
      SET "tokens" = "tokens" + ${cost}::numeric
      WHERE "key" = ${key}
    `;

    const deficit = tokens.abs().plus(cost);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(deficit.dividedBy(rule.refillPerSecond).toNumber()),
      ),
    };
  }

  return { allowed: true, remaining: Math.floor(tokens.toNumber()), retryAfterSeconds: 0 };
}

export async function enforceRateLimit(
  key: string,
  rule: RateLimitRule,
  cost = 1,
): Promise<void> {
  const result = await consumeToken(key, rule, cost);
  if (!result.allowed) {
    throw new RateLimitedError(result.retryAfterSeconds);
  }
}

/** Namespaced, so an IP limit and a user limit never share a bucket. */
export function rateLimitKey(scope: string, identifier: string): string {
  return `${scope}:${identifier}`;
}

/** Housekeeping for the worker: buckets that have long since refilled. */
export async function pruneRateLimitBuckets(olderThan: Date): Promise<number> {
  const result = await prisma.rateLimitBucket.deleteMany({
    where: { updatedAt: { lt: olderThan } },
  });
  return result.count;
}
