import { existsSync, readFileSync } from 'node:fs';

// Load .env for APP_SECRET and friends, then redirect at the test database.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, value] = match;
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

Object.assign(process.env, { NODE_ENV: 'test' });
if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(
    /\/[^/?]+(\?|$)/,
    '/fltcrypto_test$1',
  );
}

// Providers are always mocked under test. No test may reach a real network.
process.env.PAYMENT_PROVIDER = 'mock';
process.env.LIQUIDITY_PROVIDER = 'mock';
process.env.BLOCKCHAIN_PROVIDER = 'mock';
process.env.KYC_PROVIDER = 'mock';
