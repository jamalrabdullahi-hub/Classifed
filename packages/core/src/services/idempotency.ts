import { IdempotencyStatus, isUniqueViolation, prisma } from '@flt/db';
import { IdempotencyConflictError, IdempotencyInProgressError } from '../domain/errors.js';
import { newId } from '../domain/id.js';
import { hashRequest } from './crypto.js';

/**
 * Idempotency for mutating endpoints.
 *
 * The contract:
 *   - Same key, same body        -> the original response is replayed, no re-execution.
 *   - Same key, different body   -> 409. The client has a bug; do not guess.
 *   - Same key, still running    -> 409. Better than executing twice.
 *   - Same key, previously failed -> the caller may retry under the same key.
 *
 * The unique index on (endpoint, key) is what makes this safe under
 * concurrency: two simultaneous requests race to INSERT and exactly one wins.
 *
 * This matters most for trade submission. A user whose connection drops after
 * signing must be able to retry without risking a second on-chain transaction
 * being recorded against the same quote.
 */

export interface IdempotentResult<T> {
  value: T;
  /** True when a stored response was replayed rather than the handler run. */
  replayed: boolean;
}

export async function withIdempotency<T>(
  params: { key: string; endpoint: string; userId?: string | null; payload: unknown },
  handler: () => Promise<T>,
): Promise<IdempotentResult<T>> {
  const requestHash = hashRequest(params.payload);

  try {
    await prisma.idempotencyRecord.create({
      data: {
        id: newId(),
        key: params.key,
        endpoint: params.endpoint,
        userId: params.userId ?? null,
        requestHash,
        status: IdempotencyStatus.IN_PROGRESS,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const existing = await prisma.idempotencyRecord.findUnique({
      where: { endpoint_key: { endpoint: params.endpoint, key: params.key } },
    });
    if (!existing) throw error;

    // Same key must mean same request. Replaying an unrelated response would
    // be worse than failing.
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(params.key);
    }

    if (existing.status === IdempotencyStatus.COMPLETED) {
      return { value: existing.responseBody as T, replayed: true };
    }
    if (existing.status === IdempotencyStatus.IN_PROGRESS) {
      throw new IdempotencyInProgressError(params.key);
    }

    // A previous attempt failed. Let this one retry under the same key by
    // reclaiming the record; only one caller can win this update.
    const reclaimed = await prisma.idempotencyRecord.updateMany({
      where: { id: existing.id, status: IdempotencyStatus.FAILED },
      data: { status: IdempotencyStatus.IN_PROGRESS },
    });
    if (reclaimed.count === 0) {
      throw new IdempotencyInProgressError(params.key);
    }
  }

  try {
    const value = await handler();
    await prisma.idempotencyRecord.updateMany({
      where: { endpoint: params.endpoint, key: params.key },
      data: {
        status: IdempotencyStatus.COMPLETED,
        responseStatus: 200,
        responseBody: (value ?? null) as never,
        completedAt: new Date(),
      },
    });
    return { value, replayed: false };
  } catch (error) {
    await prisma.idempotencyRecord.updateMany({
      where: { endpoint: params.endpoint, key: params.key },
      data: { status: IdempotencyStatus.FAILED, completedAt: new Date() },
    });
    throw error;
  }
}

/** Housekeeping for the worker. */
export async function pruneIdempotencyRecords(olderThan: Date): Promise<number> {
  const result = await prisma.idempotencyRecord.deleteMany({
    where: { createdAt: { lt: olderThan } },
  });
  return result.count;
}
