import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

/**
 * Integration test setup.
 *
 * Runs against a real PostgreSQL database rather than a mock, because the
 * behaviour worth testing here IS the database behaviour: unique constraints
 * deciding a race, CHECK constraints refusing bad rows, transactions rolling
 * back together. A mocked client would assert that the code calls Prisma
 * correctly, which is not the same thing and is not what breaks.
 *
 * Two deliberate choices:
 *
 * **A separate schema, not a separate database.** Prisma creates it during
 * `migrate deploy`, so this needs no `psql` binary and no CREATE DATABASE
 * privilege. It works anywhere the application already works.
 *
 * **`migrate deploy` and a targeted TRUNCATE, never `migrate reset`.** Reset
 * drops everything, and pointing it at the wrong connection string destroys a
 * real database. Deploy is additive and safe to run repeatedly; the truncate
 * below names the test schema explicitly and refuses to run against any other.
 */

const TEST_SCHEMA = 'flt_test';

export function testDatabaseUrl(): string {
  const base =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://flt:flt_dev_password@localhost:5433/flt_exchange';

  const url = new URL(base);
  url.searchParams.set('schema', TEST_SCHEMA);
  return url.toString();
}

let migrated = false;

export function prepareTestDatabase(): void {
  process.env.NODE_ENV = 'test';
  process.env.APP_SECRET ??= randomBytes(48).toString('base64');
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
  process.env.DEX_ROUTER = 'mock';
  process.env.MARKET_DATA_PROVIDER = 'mock';
  process.env.MAIL_PROVIDER = 'console';
  process.env.FLT_FEE_RECIPIENT_ADDRESS = '';

  const url = testDatabaseUrl();
  process.env.DATABASE_URL = url;

  if (migrated) return;

  // Additive: creates the schema and any missing tables, changes nothing else.
  execSync('pnpm --filter @flt/db exec prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url },
  });

  migrated = true;
}

/**
 * Empties every table in the test schema.
 *
 * Guarded on the schema name so a misconfigured connection string cannot point
 * this at development or production data. TRUNCATE ... CASCADE handles the
 * foreign keys without needing a correct delete order.
 */
export async function truncateAll(prisma: {
  $queryRawUnsafe: (sql: string) => Promise<unknown>;
  $executeRawUnsafe: (sql: string) => Promise<unknown>;
}): Promise<void> {
  if (!process.env.DATABASE_URL?.includes(`schema=${TEST_SCHEMA}`)) {
    throw new Error(
      `Refusing to truncate: DATABASE_URL is not pointed at the ${TEST_SCHEMA} schema`,
    );
  }

  const tables = (await prisma.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = '${TEST_SCHEMA}' AND tablename <> '_prisma_migrations'`,
  )) as { tablename: string }[];

  if (tables.length === 0) return;

  const list = tables.map((row) => `"${TEST_SCHEMA}"."${row.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
