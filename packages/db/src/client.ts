import { Prisma, PrismaClient } from '@prisma/client';

/**
 * One Prisma client per process.
 *
 * Next.js reloads modules in development, so without the global cache each
 * reload would open a new connection pool until Postgres refused them.
 */

const globalForPrisma = globalThis as unknown as { fltPrisma?: PrismaClient };

function create(): PrismaClient {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? [{ level: 'warn', emit: 'stdout' }, { level: 'error', emit: 'stdout' }]
        : [{ level: 'error', emit: 'stdout' }],
  });
}

export const prisma: PrismaClient = globalForPrisma.fltPrisma ?? create();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.fltPrisma = prisma;
}

/**
 * Either the client or a transaction handle.
 *
 * Services take this rather than importing `prisma` directly, so any service
 * can be composed into a caller's transaction without knowing about it.
 */
export type DbClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/** Postgres unique-constraint violation. The signal that a race was lost. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Row not found where one was required. */
export function isNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/** Foreign key constraint failed. */
export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}
