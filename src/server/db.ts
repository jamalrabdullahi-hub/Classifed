import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Single Prisma instance. In development Next.js hot-reloads modules, so the
 * client is stashed on globalThis to avoid exhausting the connection pool.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export { Prisma };

/**
 * A transaction-scoped client. Every money-moving service takes one of these so
 * a caller can compose several operations into one atomic unit.
 */
export type Tx = Prisma.TransactionClient;

export type DbClient = PrismaClient | Tx;

/**
 * Run `fn` inside a serializable transaction.
 *
 * Serializable is the right default here: balance reads that inform a debit must
 * not see a snapshot that a concurrent transaction is about to invalidate.
 * Postgres will abort one of two conflicting transactions with 40001, which the
 * retry loop below handles.
 */
export async function inTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: { retries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: options.timeoutMs ?? 15_000,
        maxWait: 5_000,
      });
    } catch (error) {
      if (isSerializationFailure(error) && attempt < retries) {
        lastError = error;
        // Exponential backoff with jitter, so retrying peers do not re-collide.
        const delay = 2 ** attempt * 25 + Math.random() * 25;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export function isSerializationFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2034: write conflict / deadlock detected.
    if (error.code === 'P2034') return true;
  }
  const message = error instanceof Error ? error.message : '';
  return message.includes('40001') || message.includes('could not serialize access');
}

/** Unique constraint violation — used to turn races into idempotent no-ops. */
export function isUniqueViolation(error: unknown, target?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  if (!target) return true;
  const meta = error.meta as { target?: string[] | string } | undefined;
  const fields = Array.isArray(meta?.target) ? meta.target : meta?.target ? [meta.target] : [];
  return fields.some((f) => f.includes(target));
}
