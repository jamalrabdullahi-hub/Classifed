import { prisma } from '@flt/db';
import { expireStaleQuotes } from '@flt/core/services/quotes';
import { pruneWalletNonces } from '@flt/core/services/wallets';
import { pruneExpiredSessions } from '@flt/core/services/sessions';
import { pruneRateLimitBuckets } from '@flt/core/services/ratelimit';
import { pruneIdempotencyRecords } from '@flt/core/services/idempotency';

/**
 * Housekeeping.
 *
 * Most of this is deleting rows that have served their purpose. The one job
 * with user-visible consequences is expiring quotes: a quote whose window has
 * closed must not sit in the database looking usable, because the trade
 * submission path checks status as well as time.
 *
 * Everything here is idempotent and safe to run concurrently with itself.
 */

export interface HousekeepingResult {
  quotesExpired: number;
  noncesPruned: number;
  sessionsPruned: number;
  bucketsPruned: number;
  idempotencyPruned: number;
  emailTokensPruned: number;
}

export async function runHousekeeping(): Promise<HousekeepingResult> {
  const now = Date.now();

  const [quotesExpired, noncesPruned, sessionsPruned, bucketsPruned, idempotencyPruned, emailTokens] =
    await Promise.all([
      expireStaleQuotes(),
      pruneWalletNonces(),
      pruneExpiredSessions(),
      // A bucket untouched for an hour has fully refilled, so deleting it is
      // equivalent to keeping it and saves the row.
      pruneRateLimitBuckets(new Date(now - 60 * 60 * 1_000)),
      // Idempotency records are kept long enough to cover any plausible client
      // retry, then dropped.
      pruneIdempotencyRecords(new Date(now - 7 * 24 * 60 * 60 * 1_000)),
      prisma.emailToken.deleteMany({
        where: { expiresAt: { lt: new Date(now - 24 * 60 * 60 * 1_000) } },
      }),
    ]);

  return {
    quotesExpired,
    noncesPruned,
    sessionsPruned,
    bucketsPruned,
    idempotencyPruned,
    emailTokensPruned: emailTokens.count,
  };
}
