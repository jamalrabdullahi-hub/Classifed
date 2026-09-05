import type { ProviderKind } from '@prisma/client';
import { newId } from '../domain/id';
import { hashRequest } from '../server/crypto';
import { isUniqueViolation, prisma } from '../server/db';
import type { ProviderResult } from '../providers/common';
import { redact } from './audit';

/**
 * Wraps every outbound provider call in a durable record.
 *
 * This is what makes recovery possible after a timeout: if `placeOrder` never
 * returns, the ProviderTransaction row still exists in PENDING with the
 * idempotency key we used, so a reconciliation run knows to go and ask the
 * provider what actually happened rather than guessing.
 */

export interface ProviderCallInput {
  provider: string;
  providerKind: ProviderKind;
  operation: string;
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  request: unknown;
}

export async function recordProviderCall<T>(
  input: ProviderCallInput,
  call: () => Promise<ProviderResult<T>>,
): Promise<ProviderResult<T>> {
  const requestHash = hashRequest(input.request);
  const startedAt = Date.now();
  const id = newId();

  try {
    await prisma.providerTransaction.create({
      data: {
        id,
        provider: input.provider,
        providerKind: input.providerKind,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        requestHash,
        requestPayload: redact(input.request) as never,
        status: 'PENDING',
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // This exact call was already made. The provider adapters are themselves
    // idempotent on the key, so it is safe to proceed and let them dedupe.
  }

  try {
    const result = await call();

    await prisma.providerTransaction.updateMany({
      where: { idempotencyKey: input.idempotencyKey },
      data: {
        status: 'SUCCEEDED',
        externalId: result.externalId ?? null,
        responsePayload: redact(result.raw ?? result.data) as never,
        completedAt: new Date(),
        latencyMs: Date.now() - startedAt,
      },
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = /timeout|timed out|ECONNRESET|ETIMEDOUT/i.test(message);

    await prisma.providerTransaction.updateMany({
      where: { idempotencyKey: input.idempotencyKey },
      data: {
        // A timeout is genuinely UNKNOWN, not FAILED — the operation may well
        // have succeeded at the provider. Reconciliation must resolve it.
        status: isTimeout ? 'UNKNOWN' : 'FAILED',
        errorMessage: message.slice(0, 1000),
        completedAt: new Date(),
        latencyMs: Date.now() - startedAt,
      },
    });

    throw error;
  }
}

/** Calls whose outcome we never learned. The reconciler's work queue. */
export async function findUnresolvedCalls(olderThanMs = 60_000) {
  return prisma.providerTransaction.findMany({
    where: {
      status: { in: ['PENDING', 'UNKNOWN'] },
      startedAt: { lt: new Date(Date.now() - olderThanMs) },
    },
    orderBy: { startedAt: 'asc' },
    take: 200,
  });
}
