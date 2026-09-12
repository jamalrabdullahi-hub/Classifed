/**
 * API endpoint smoke: hits every web route and reports the status, failing on
 * any 5xx. Auth-required routes returning 401/403 and validation returning 400
 * are expected — the check is that no handler crashes.
 *
 * Run with the web app up (pnpm --filter @flt/web dev).
 */
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';

const PATHS = [
  '/api/account/mfa/confirm',
  '/api/account/mfa/enroll',
  '/api/approvals/execute',
  '/api/approvals',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/mfa',
  '/api/auth/password-reset/confirm',
  '/api/auth/password-reset',
  '/api/auth/register',
  '/api/auth/verify-email/resend',
  '/api/auth/verify-email',
  '/api/checkout/evc',
  '/api/deposits',
  '/api/kyc',
  '/api/markets/0x0000000000000000000000000000000000000001/candles',
  '/api/passive-cash',
  '/api/perps/markets',
  '/api/perps/markets/BTC/book',
  '/api/perps/markets/BTC/candles',
  '/api/perps/markets/BTC/protection',
  '/api/perps/markets/BTC/trades',
  '/api/perps/orders/execute',
  '/api/perps/orders',
  '/api/perps/orders/00000000-0000-0000-0000-000000000000',
  '/api/perps/positions',
  '/api/protection/policies',
  '/api/protection/policies/00000000-0000-0000-0000-000000000000/fund',
  '/api/protection/policies/00000000-0000-0000-0000-000000000000/rebase',
  '/api/protection/policies/00000000-0000-0000-0000-000000000000/reduce',
  '/api/protection/policies/00000000-0000-0000-0000-000000000000',
  '/api/protection/purchase',
  '/api/protection/quote',
  '/api/quotes/price',
  '/api/quotes',
  '/api/referrals',
  '/api/remittance',
  '/api/search',
  '/api/subscriptions',
  '/api/tokens',
  '/api/trades/execute',
  '/api/trades',
  '/api/transactions',
  '/api/transactions/00000000-0000-0000-0000-000000000000',
  '/api/wallets/challenge',
  '/api/wallets/delegation',
  '/api/wallets/link',
  '/api/wallets/provision',
  '/api/wallets',
  '/api/wallets/usd-balance',
  '/api/wallets/00000000-0000-0000-0000-000000000000',
  '/api/withdrawals',
];

async function hit(path: string): Promise<{ method: string; status: number }> {
  for (const method of ['GET', 'POST'] as const) {
    const res = await fetch(BASE + path, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
      body: method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(40_000),
    });
    if (res.status !== 405) return { method, status: res.status };
  }
  return { method: 'GET/POST', status: 405 };
}

async function main(): Promise<void> {
  let failures = 0;
  for (const path of PATH_PATHS()) {
    try {
      const { method, status } = await hit(path);
      const bad = status >= 500;
      if (bad) failures += 1;
      console.info(`${bad ? 'FAIL' : 'ok  '}  ${method.padEnd(4)} ${String(status).padEnd(3)} ${path}`);
    } catch (error) {
      failures += 1;
      console.info(`FAIL  ERR  ${path} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.info(`\n${PATHS.length} endpoints, ${failures} failing (5xx/network).`);
  if (failures > 0) process.exitCode = 1;
}

function PATH_PATHS(): string[] {
  return PATHS;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
export {};
