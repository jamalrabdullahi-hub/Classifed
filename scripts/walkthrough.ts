/**
 * End-to-end walkthrough against a running dev server.
 *
 *   npm run dev          (in one terminal)
 *   npx tsx scripts/walkthrough.ts
 *
 * Exercises the golden path a customer actually takes, plus the abuse cases:
 * a replayed webhook, a reused quote, and a duplicated order request.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

let cookie = '';
let failures = 0;

function log(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; data: T; error?: { code: string; message: string } }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;

  const payload = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { code: string; message: string };
  };
  return { status: response.status, data: payload.data as T, error: payload.error };
}

const uid = Date.now();

/**
 * Clear this host's rate-limit buckets so the script is repeatable.
 *
 * A dev-tool concession, not a product behaviour: registration is capped at
 * 3/hour per IP, which a repeated walkthrough would otherwise exhaust. The
 * limiter itself is exercised deliberately at the end.
 */
async function clearRateLimits(): Promise<void> {
  const { prisma } = await import('../src/server/db');
  await prisma.rateLimitBucket.deleteMany({});
  await prisma.$disconnect();
}

async function main(): Promise<void> {
  console.log(`Walkthrough against ${BASE}\n`);
  await clearRateLimits();

  // --- 1. Register --------------------------------------------------------
  console.log('1. Account');
  const email = `walkthrough+${uid}@example.com`;
  const registered = await call('POST', '/api/auth/register', {
    email,
    password: 'Password123!',
    phone: `+2526${String(uid).slice(-8)}`,
  });
  log(
    registered.status === 200,
    'register',
    `${email} ${registered.error?.code ?? ''}`,
  );

  // --- 2. KYC -------------------------------------------------------------
  console.log('\n2. KYC');
  const beforeKyc = await call<{ id: string }>('POST', '/api/quotes', {
    assetSymbol: 'BTC',
    side: 'BUY',
    fiatAmount: '100',
  });
  log(
    beforeKyc.status === 403,
    'trading blocked before verification',
    beforeKyc.error?.code,
  );

  const kyc = await call<{ status: string; tier: number }>('POST', '/api/kyc', {
    fullName: 'Test Customer',
    dateOfBirth: '1990-01-01',
    nationality: 'SO',
    addressLine: '1 Test Street',
    city: 'Mogadishu',
    country: 'SO',
    documentType: 'NATIONAL_ID',
    documentNumber: `ID-${uid}`,
  });
  log(kyc.data?.status === 'APPROVED', 'verification approved', `tier ${kyc.data?.tier}`);

  // --- 3. Balance ---------------------------------------------------------
  console.log('\n3. Balances');
  type Balance = { symbol: string; available: string; held: string; total: string };
  const empty = await call<Balance[]>('GET', '/api/balances');
  const usdStart = empty.data.find((b) => b.symbol === 'USD');
  log(usdStart?.available === '0.00', 'starts at $0.00', usdStart?.available);
  log(empty.data.length === 6, 'all six assets listed', `${empty.data.length} assets`);

  // --- 4. Deposit ---------------------------------------------------------
  console.log('\n4. Deposit');
  const deposit = await call<{ id: string; status: string; amount: string }>(
    'POST',
    '/api/deposits',
    { amount: '500', payerAccountRef: '+252612345678' },
    `dep-${uid}`,
  );
  log(deposit.data?.status === 'AWAITING_PAYMENT', 'payment request created');

  const duplicate = await call<{ id: string }>(
    'POST',
    '/api/deposits',
    { amount: '500', payerAccountRef: '+252612345678' },
    `dep-${uid}`,
  );
  log(duplicate.data?.id === deposit.data.id, 'duplicate idempotency key replayed');

  const noKey = await call('POST', '/api/deposits', {
    amount: '500',
    payerAccountRef: '+252612345678',
  });
  log(noKey.status === 400, 'missing Idempotency-Key rejected', noKey.error?.code);

  const credited = await call<{ status: string; netAmount: string }>(
    'GET',
    `/api/deposits/${deposit.data.id}`,
  );
  log(credited.data?.status === 'CREDITED', 'verified and credited', credited.data?.netAmount);

  const funded = await call<Balance[]>('GET', '/api/balances');
  const usdFunded = funded.data.find((b) => b.symbol === 'USD');
  log(usdFunded?.available === '495.00', 'balance reflects the 1% provider fee', usdFunded?.available);

  // --- 5. Quote -----------------------------------------------------------
  console.log('\n5. Quote');
  type Quote = {
    id: string;
    cryptoAmount: string;
    brokerageFee: string;
    exchangeRate: string;
    minOutputAmount: string;
    priceImpactBps: number;
    expiresInSeconds: number;
  };
  const quote = await call<Quote>('POST', '/api/quotes', {
    assetSymbol: 'BTC',
    side: 'BUY',
    fiatAmount: '100',
  });
  log(Number(quote.data?.cryptoAmount) > 0, 'priced', `${quote.data?.cryptoAmount} BTC`);
  log(quote.data?.brokerageFee === '1', 'brokerage fee is 1%', `$${quote.data?.brokerageFee}`);
  log(quote.data?.expiresInSeconds > 0, 'expires', `${quote.data?.expiresInSeconds}s`);
  log(
    Number(quote.data?.minOutputAmount) > 0 &&
      Number(quote.data?.minOutputAmount) < Number(quote.data?.cryptoAmount),
    'quotes a guaranteed minimum below the expected amount',
    `${quote.data?.minOutputAmount} BTC`,
  );
  log(
    typeof quote.data?.priceImpactBps === 'number',
    'reports price impact',
    `${quote.data?.priceImpactBps}bps`,
  );

  const tooSmall = await call('POST', '/api/quotes', {
    assetSymbol: 'BTC',
    side: 'BUY',
    fiatAmount: '1',
  });
  log(tooSmall.status === 400, 'below-minimum order rejected', tooSmall.error?.code);

  // --- 6. Buy -------------------------------------------------------------
  console.log('\n6. Buy');
  type Order = {
    id: string;
    status: string;
    filledCryptoAmount: string;
    executionPrice: string | null;
    providerOrderId: string | null;
    executionVenue: string | null;
    priceImpactBps: number | null;
    trades: { quantity: string; executedPrice: string }[];
  };
  const order = await call<Order>(
    'POST',
    '/api/orders',
    { quoteId: quote.data.id },
    `ord-${uid}`,
  );
  log(order.data?.status === 'SETTLED', 'order settled', order.data?.status);
  log(Number(order.data?.filledCryptoAmount) > 0, 'crypto credited', order.data?.filledCryptoAmount);
  log(Boolean(order.data?.executionPrice), 'execution price recorded', order.data?.executionPrice ?? '');
  log(
    Boolean(order.data?.executionVenue),
    'execution venue recorded',
    order.data?.executionVenue ?? '',
  );
  log(order.data?.trades.length > 0, 'trades recorded', `${order.data?.trades.length}`);

  const replayedOrder = await call<Order>(
    'POST',
    '/api/orders',
    { quoteId: quote.data.id },
    `ord-${uid}`,
  );
  log(replayedOrder.data?.id === order.data.id, 'duplicate order request replayed');

  // A different API idempotency key, same quote. The order's own key is derived
  // from the quote id, so one quote can only ever produce one order — the second
  // request returns the original rather than buying again.
  const reuse = await call<Order>(
    'POST',
    '/api/orders',
    { quoteId: quote.data.id },
    `ord-reuse-${uid}`,
  );
  log(
    reuse.data?.id === order.data.id,
    'a quote can only ever produce one order',
    reuse.data?.id === order.data.id ? 'same order returned' : `got ${reuse.status}`,
  );

  // --- 7. Sell ------------------------------------------------------------
  console.log('\n7. Sell');
  const afterBuy = await call<Balance[]>('GET', '/api/balances');
  const btc = afterBuy.data.find((b) => b.symbol === 'BTC');
  const sellAmount = (Number(btc?.available ?? 0) / 2).toFixed(8);

  const sellQuote = await call<Quote>('POST', '/api/quotes', {
    assetSymbol: 'BTC',
    side: 'SELL',
    cryptoAmount: sellAmount,
  });
  log(Boolean(sellQuote.data?.id), 'sell quote priced');

  const sell = await call<Order>(
    'POST',
    '/api/orders',
    { quoteId: sellQuote.data.id },
    `sell-${uid}`,
  );
  log(sell.data?.status === 'SETTLED', 'sale settled', sell.data?.status);

  // --- 8. Withdraw --------------------------------------------------------
  console.log('\n8. Withdrawal');
  const wallet = await call<{ id: string }>('POST', '/api/wallets', {
    assetSymbol: 'BTC',
    address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    label: 'Test wallet',
  });
  log(Boolean(wallet.data?.id), 'wallet saved');

  const badWallet = await call('POST', '/api/wallets', {
    assetSymbol: 'BTC',
    address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
  });
  log(badWallet.status === 400, 'wrong-chain address rejected', badWallet.error?.code);

  type Withdrawal = {
    id: string;
    status: string;
    netAmount: string;
    txHash: string | null;
    confirmationCode?: string;
  };
  const withdrawal = await call<Withdrawal>(
    'POST',
    '/api/withdrawals',
    // Sized against what is actually left after the sale above.
    { assetSymbol: 'BTC', amount: '0.0006', walletId: wallet.data.id },
    `wd-${uid}`,
  );
  log(
    withdrawal.data?.status === 'AWAITING_CONFIRMATION',
    'withdrawal awaits confirmation',
    withdrawal.data?.status ?? `${withdrawal.status} ${withdrawal.error?.message ?? ''}`,
  );

  const heldBalance = await call<Balance[]>('GET', '/api/balances');
  const btcDuring = heldBalance.data.find((b) => b.symbol === 'BTC');
  log(btcDuring?.held === '0.00000000', 'nothing held before confirmation', btcDuring?.held);

  const wrongCode = await call(
    'POST',
    `/api/withdrawals/${withdrawal.data.id}/confirm`,
    { code: '000000' },
  );
  log(wrongCode.status === 400, 'wrong confirmation code rejected');

  const confirmed = await call<Withdrawal>(
    'POST',
    `/api/withdrawals/${withdrawal.data.id}/confirm`,
    { code: withdrawal.data.confirmationCode },
  );
  log(
    ['SUBMITTED', 'BROADCAST', 'COMPLETED'].includes(confirmed.data?.status),
    'withdrawal submitted',
    confirmed.data?.status,
  );

  let settled = confirmed.data;
  for (let i = 0; i < 8 && settled.status !== 'COMPLETED'; i += 1) {
    settled = (await call<Withdrawal>('GET', `/api/withdrawals/${withdrawal.data.id}`)).data;
  }
  log(settled.status === 'COMPLETED', 'withdrawal completed', settled.txHash ?? '');

  // --- 9. History ---------------------------------------------------------
  console.log('\n9. Transactions');
  const history = await call<{ type: string; changes: { symbol: string; amount: string }[] }[]>(
    'GET',
    '/api/transactions',
  );
  const types = history.data.map((h) => h.type);
  log(history.data.length > 0, 'history returned', `${history.data.length} entries`);
  for (const expected of ['USD_DEPOSIT', 'CRYPTO_PURCHASE', 'CRYPTO_SALE', 'CRYPTO_WITHDRAWAL']) {
    log(types.includes(expected), `history includes ${expected}`);
  }

  // --- 10. Authorization --------------------------------------------------
  console.log('\n10. Authorization');
  const savedCookie = cookie;
  cookie = '';
  const anonymous = await call('GET', '/api/balances');
  log(anonymous.status === 401, 'balances require a session', anonymous.error?.code);
  const anonymousOrder = await call('POST', '/api/orders', { quoteId: quote.data.id }, `x-${uid}`);
  log(anonymousOrder.status === 401, 'orders require a session');
  cookie = savedCookie;

  // --- 11. Webhooks -------------------------------------------------------
  console.log('\n11. Webhooks');
  const { createHmac } = await import('node:crypto');
  const eventBody = JSON.stringify({
    eventId: `evt-${uid}`,
    event: 'deposit.succeeded',
    paymentId: 'unknown-payment',
    amount: '100',
    currency: 'USD',
    occurredAt: new Date().toISOString(),
  });
  const signature = createHmac('sha256', 'mock-webhook-secret').update(eventBody).digest('hex');

  const send = (body: string, sig: string) =>
    fetch(`${BASE}/api/webhooks/payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mock-signature': sig },
      body,
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as { status?: string } }));

  const first = await send(eventBody, signature);
  log(first.body.status === 'PROCESSED', 'signed webhook processed', first.body.status);

  const replay = await send(eventBody, signature);
  log(replay.body.status === 'DUPLICATE', 'replayed webhook deduplicated', replay.body.status);

  const forged = await send(eventBody, 'deadbeef');
  log(forged.status === 400, 'unsigned webhook rejected');

  const tampered = await send(
    JSON.stringify({ eventId: `evt-${uid}`, event: 'deposit.succeeded', amount: '999999' }),
    signature,
  );
  log(tampered.status === 400, 'tampered webhook rejected');

  // --- 12. On-chain execution controls -------------------------------------
  console.log('\n12. Execution controls');

  type AssetRow = {
    symbol: string;
    liquidityTier: string;
    executionMode: string;
    maxDexTradeUsd: string;
  };
  const assets = await call<AssetRow[]>('GET', '/api/assets');
  const btcAsset = assets.data.find((a) => a.symbol === 'BTC');
  log(btcAsset?.liquidityTier === 'TIER_1', 'BTC is tier 1', btcAsset?.liquidityTier);
  log(btcAsset?.executionMode === 'INSTANT', 'BTC executes instantly');

  // Size cap: well above the per-asset on-chain ceiling.
  const oversized = await call('POST', '/api/quotes', {
    assetSymbol: 'BTC',
    side: 'BUY',
    fiatAmount: '50000',
  });
  log(oversized.status === 400, 'oversized order refused', oversized.error?.code);

  // Best execution: every venue considered is recorded against the order.
  const attempts = await call<{ venueKind: string; status: string }[]>(
    'GET',
    `/api/orders/${order.data.id}/attempts`,
  );
  log(
    Array.isArray(attempts.data) && attempts.data.length >= 2,
    'best-execution record kept',
    `${attempts.data?.length ?? 0} venues considered`,
  );

  // --- 13. Rate limiting ---------------------------------------------------
  console.log('\n12. Rate limiting');
  let limited = false;
  for (let i = 0; i < 12 && !limited; i += 1) {
    const attempt = await call(
      'POST',
      '/api/withdrawals',
      { assetSymbol: 'BTC', amount: '0.0006', walletId: wallet.data.id },
      `rl-${uid}-${i}`,
    );
    if (attempt.error?.code === 'RATE_LIMITED') limited = true;
  }
  log(limited, 'withdrawal endpoint rate limits a burst');

  console.log(
    `\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
