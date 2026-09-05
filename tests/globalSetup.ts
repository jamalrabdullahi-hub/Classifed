import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Creates and migrates a dedicated `fltcrypto_test` database, so a test run can
 * never touch development data. Requires the docker-compose Postgres to be up:
 *
 *   npm run db:up
 */

const TEST_DB = 'fltcrypto_test';
const CONTAINER = 'fltcrypto-postgres';

function loadDotEnv(): void {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, value] = match;
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function psql(database: string, sql: string): string {
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'fltcrypto', '-d', database, '-tAc', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

export function testDatabaseUrl(): string {
  const base = process.env.DATABASE_URL ?? '';
  return base.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);
}

export default async function globalSetup(): Promise<void> {
  loadDotEnv();

  try {
    const exists = psql('postgres', `SELECT 1 FROM pg_database WHERE datname = '${TEST_DB}'`);
    if (exists !== '1') {
      psql('postgres', `CREATE DATABASE ${TEST_DB}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach the test database. Is the container running? Try: npm run db:up\n${message}`,
    );
  }

  const url = testDatabaseUrl();
  process.env.DATABASE_URL = url;
  process.env.TEST_DATABASE_URL = url;
  Object.assign(process.env, { NODE_ENV: 'test' });

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}
