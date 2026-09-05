import { IdempotencyConflictError } from '../domain/errors';
import { newId } from '../domain/id';
import { hashRequest } from '../server/crypto';
import { isUniqueViolation, prisma } from '../server/db';

/**
 * Idempotency for mutating financial endpoints.
 *
 * The contract:
 *   * Same key, same body   -> the original response is replayed. No re-execution.
 *   * Same key, different body -> 409. The client has a bug; do not guess.
 *   * Same key, still running  -> 409 with a retry hint, rather than executing twice.
 *
 * The unique index on (endpoint, key) is what makes this safe under concurrency:
 * two simultaneous requests race to INSERT, and exactly one wins.
 */

export interface IdempotentResult<T> {
  value: T;
  /** True when the stored response was replayed rather than the handler run. */
  replayed: boolean;
}

export class IdempotencyInProgressError extends IdempotencyConflictError {
  constructor(key: string) {
    super(key);
  }
}

export async function withIdempotency<T>(
  params: {
    key: string;
    endpoint: string;
    userId?: string | null;
    payload: unknown;
  },
  handler: () => Promise<T>,
): Promise<IdempotentResult<T>> {
  const requestHash = hashRequest(params.payload);
  const recordId = newId();

  try {
    await prisma.idempotencyRecord.create({
      data: {
        id: recordId,
        key: params.key,
        endpoint: params.endpoint,
        userId: params.userId ?? null,
        requestHash,
        status: 'IN_PROGRESS',
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const existing = await prisma.idempotencyRecord.findUnique({
      where: { endpoint_key: { endpoint: params.endpoint, key: params.key } },
    });
    if (!existing) throw error;

    // Same key must mean same request. Anything else is a client bug, and
    // replaying an unrelated response would be worse than failing.
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(params.key);
    }

    if (existing.status === 'COMPLETED') {
      return { value: existing.responseBody as T, replayed: true };
    }
    if (existing.status === 'IN_PROGRESS') {
      throw new IdempotencyInProgressError(params.key);
    }

    // A previous attempt failed. Let this one retry under the same key by
    // reclaiming the record; only one caller can win this update.
    const reclaimed = await prisma.idempotencyRecord.updateMany({
      where: { id: existing.id, status: 'FAILED' },
      data: { status: 'IN_PROGRESS', updatedAt: new Date() },
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
        status: 'COMPLETED',
        responseStatus: 200,
        responseBody: (value ?? null) as never,
        completedAt: new Date(),
      },
    });
    return { value, replayed: false };
  } catch (error) {
    await prisma.idempotencyRecord.updateMany({
      where: { endpoint: params.endpoint, key: params.key },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    throw error;
  }
}

/** Deterministic key for a ledger posting derived from a business event. */
export function ledgerKey(referenceType: string, referenceId: string, step: string): string {
  return `${referenceType}:${referenceId}:${step}`;
}
