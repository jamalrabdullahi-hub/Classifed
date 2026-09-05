import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Single Prisma instance, constructed lazily.
 *
 * Two runtimes are supported and they connect differently:
 *
 * Both runtimes go through `@prisma/adapter-pg`. The client is generated with
 * the `queryCompiler` preview feature, which produces no Rust query engine —
 * workerd cannot load that binary, and requiring the adapter everywhere keeps
 * one code path rather than two subtly different ones.
 *
 *  - **Node** (local, tests, the systemd deployment) connects with
 *    `DATABASE_URL` directly.
 *  - **Cloudflare Workers** prefers the Hyperdrive binding, falling back to a
 *    `DATABASE_URL` secret.
 *
 * Construction is deferred until first use because on Workers the environment
 * is not populated at module-evaluation time. The Proxy below keeps the
 * `prisma` export a plain object to every caller, so no call site changes.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * True when running on workerd. Checked via `navigator.userAgent`, which
 * Cloudflare sets to this exact string, rather than by sniffing for absent Node
 * globals — `nodejs_compat` provides many of those, so their presence proves
 * nothing.
 */
function isWorkerRuntime(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator as { userAgent?: string }).userAgent === 'Cloudflare-Workers'
  );
}

/**
 * Where a Worker gets its connection string.
 *
 * Hyperdrive is preferred: it pools connections, which matters because every
 * Worker isolate would otherwise open its own. Its string is only available
 * through the request context, so this is read lazily and falls back to a
 * plain `DATABASE_URL` secret when no binding is present.
 *
 * NOTE: Hyperdrive query caching MUST stay disabled for this application. A
 * cached read of a balance is a wrong balance.
 */
function workerConnectionString(): string | undefined {
  try {
    // Resolved at runtime so the Node build never pulls in the adapter.
    const mod = require('@opennextjs/cloudflare') as {
      getCloudflareContext?: () => { env?: Record<string, unknown> };
    };
    const env = mod.getCloudflareContext?.().env;
    const hyperdrive = env?.HYPERDRIVE as { connectionString?: string } | undefined;
    if (hyperdrive?.connectionString) return hyperdrive.connectionString;
    const fromEnv = env?.DATABASE_URL;
    if (typeof fromEnv === 'string' && fromEnv) return fromEnv;
  } catch {
    // No Cloudflare context (or the module is absent) — fall through.
  }
  return process.env.DATABASE_URL;
}

function createClient(): PrismaClient {
  const log: Prisma.LogLevel[] =
    process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'];

  const connectionString = isWorkerRuntime()
    ? workerConnectionString()
    : process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      isWorkerRuntime()
        ? 'No database connection string on Workers. Bind Hyperdrive as HYPERDRIVE, ' +
          'or set DATABASE_URL as a Worker secret.'
        : 'DATABASE_URL is not set.',
    );
  }

  return new PrismaClient({ adapter: new PrismaPg({ connectionString }), log });
}

function client(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createClient();
  }
  return globalForPrisma.prisma;
}

/**
 * The client. A Proxy so that construction happens on first property access
 * rather than at import time; behaviour is otherwise identical to holding the
 * PrismaClient directly.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const value = Reflect.get(client(), property, receiver);
    return typeof value === 'function' ? value.bind(client()) : value;
  },
  has: (_target, property) => property in client(),
});

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
      return await client().$transaction(fn, {
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
