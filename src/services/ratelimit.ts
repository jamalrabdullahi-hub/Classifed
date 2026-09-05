import { Decimal } from '../domain/money';
import { RateLimitedError } from '../domain/errors';
import { newId } from '../domain/id';
import { prisma } from '../server/db';

/**
 * Token-bucket rate limiting, backed by Postgres.
 *
 * Postgres rather than Redis because this MVP already depends on Postgres and
 * adding a second datastore for one feature is not worth the operational cost.
 * The interface is narrow enough that swapping in Redis later is a one-file change.
 *
 * The refill and consume happen in a single UPDATE, so concurrent requests
 * cannot both see a full bucket.
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
  REGISTER: { capacity: 3, refillPerSecond: 3 / 3600 },
  /** Quotes are cheap but hit the venue; allow a working pace, not a scraper. */
  QUOTE: { capacity: 30, refillPerSecond: 0.5 },
  ORDER: { capacity: 10, refillPerSecond: 10 / 60 },
  DEPOSIT: { capacity: 10, refillPerSecond: 10 / 60 },
  /** Withdrawals are the highest-value action in the system. */
  WITHDRAWAL: { capacity: 5, refillPerSecond: 5 / 600 },
  WITHDRAWAL_CONFIRM: { capacity: 5, refillPerSecond: 5 / 300 },
  API_GENERAL: { capacity: 120, refillPerSecond: 2 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Consume one token from `key`'s bucket.
 *
 * Returns rather than throws, so callers can decide whether to reject or to
 * degrade. Use `enforceRateLimit` for the common reject-with-429 case.
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
      retryAfterSeconds: Math.max(1, Math.ceil(deficit.dividedBy(rule.refillPerSecond).toNumber())),
    };
  }

  return {
    allowed: true,
    remaining: Math.floor(tokens.toNumber()),
    retryAfterSeconds: 0,
  };
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

/** Namespaced key so an IP limit and a user limit never share a bucket. */
export function rateLimitKey(scope: string, identifier: string): string {
  return `${scope}:${identifier}`;
}
