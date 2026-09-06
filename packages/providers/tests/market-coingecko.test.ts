import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@flt/config';
import { CoinGeckoMarketDataProvider } from '../src/market/coingecko';

// The adapter reads configuration through env(), which validates the whole
// schema on first use. These are the minimum required to let it load.
process.env.DATABASE_URL ??= 'postgresql://flt:flt@localhost:5432/flt_test';
process.env.APP_SECRET ??= 'a'.repeat(48);
// Must decode to exactly 32 bytes.
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

/**
 * The CoinGecko adapter.
 *
 * These pin down two behaviours that were wrong in a way no type could catch,
 * and that only showed up against the live API: the native-asset sentinel being
 * sent to a contract-price endpoint, and multiple contract addresses in one
 * request. Either one caused the provider to return NOTHING — every token in
 * the registry lost its price, not just the offending one.
 */

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';
const DAI = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb';

interface Call {
  url: string;
}

/** Records every request and replies from a per-URL handler. */
function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
  const calls: Call[] = [];

  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    calls.push({ url });
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });

  return calls;
}

const priceEntry = { usd: 1.23, usd_24h_change: 4.5, usd_24h_vol: 1_000, usd_market_cap: 9_000 };

beforeEach(() => {
  // The keyless tier is the one with the tight limits, and the one a fresh
  // checkout runs on. env() caches, so the cache has to go with it.
  delete process.env.COINGECKO_API_KEY;
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.COINGECKO_API_KEY;
  resetEnvCache();
});

describe('CoinGecko adapter', () => {
  it('never sends the native sentinel to the contract-price endpoint', async () => {
    /*
     * The original bug. The sentinel is not a real contract, so including it
     * made CoinGecko reject the entire request — one pseudo-address cost every
     * other token its price.
     */
    const calls = stubFetch((url) =>
      url.includes('/simple/price')
        ? { status: 200, body: { ethereum: priceEntry } }
        : { status: 200, body: { [USDC.toLowerCase()]: priceEntry } },
    );

    const provider = new CoinGeckoMarketDataProvider();
    const data = await provider.getTokenData({
      chainId: 8453,
      tokenAddresses: [NATIVE, USDC],
    });

    const contractCalls = calls.filter((call) => call.url.includes('token_price'));
    expect(contractCalls).toHaveLength(1);
    for (const call of contractCalls) {
      expect(call.url.toLowerCase()).not.toContain(NATIVE.toLowerCase());
    }

    // And the native asset is still priced, via the coin endpoint.
    expect(calls.some((call) => call.url.includes('/simple/price'))).toBe(true);
    expect(data.map((entry) => entry.tokenAddress)).toContain(NATIVE);
  });

  it('sends one contract address per request without an API key', async () => {
    // Verified against the live API: two addresses in one call already fails
    // with error 10012, and the failure takes the whole request with it.
    const calls = stubFetch(() => ({ status: 200, body: {} }));

    const provider = new CoinGeckoMarketDataProvider();
    await provider.getTokenData({ chainId: 8453, tokenAddresses: [USDC, AERO, DAI] });

    const contractCalls = calls.filter((call) => call.url.includes('token_price'));
    expect(contractCalls).toHaveLength(3);

    for (const call of contractCalls) {
      const addresses = new URL(call.url).searchParams.get('contract_addresses');
      expect(addresses?.split(',')).toHaveLength(1);
    }
  });

  it('batches contract addresses when a key is configured', async () => {
    process.env.COINGECKO_API_KEY = 'test-key';
    resetEnvCache();
    const calls = stubFetch(() => ({ status: 200, body: {} }));

    const provider = new CoinGeckoMarketDataProvider();
    await provider.getTokenData({ chainId: 8453, tokenAddresses: [USDC, AERO, DAI] });

    expect(calls.filter((call) => call.url.includes('token_price'))).toHaveLength(1);
  });

  it('returns the tokens it could price when some requests fail', async () => {
    /*
     * The property that matters on a rate-limited free tier: a failure
     * part-way through a token list is routine, and it must not blank out the
     * prices that did come back.
     */
    const calls = stubFetch((url) => {
      if (url.toLowerCase().includes(AERO.toLowerCase())) {
        return { status: 429, body: { status: { error_code: 429 } } };
      }
      const address = new URL(url).searchParams.get('contract_addresses')!.toLowerCase();
      return { status: 200, body: { [address]: priceEntry } };
    });

    const provider = new CoinGeckoMarketDataProvider();
    const data = await provider.getTokenData({
      chainId: 8453,
      tokenAddresses: [USDC, AERO, DAI],
    });

    expect(calls.filter((call) => call.url.includes('token_price'))).toHaveLength(3);

    const priced = data.map((entry) => entry.tokenAddress);
    expect(priced).toContain(USDC);
    expect(priced).toContain(DAI);
    expect(priced).not.toContain(AERO);
  });

  it('throws when every request fails, rather than caching an empty refresh', async () => {
    // A total outage is not a partial result, and the caller has to be able to
    // tell the difference.
    stubFetch(() => ({ status: 500, body: {} }));

    const provider = new CoinGeckoMarketDataProvider();
    await expect(
      provider.getTokenData({ chainId: 8453, tokenAddresses: [USDC, AERO] }),
    ).rejects.toThrow(/unavailable/i);
  });

  it('reports a missing liquidity figure as null rather than zero', async () => {
    // This endpoint does not report pool reserves. Substituting volume, or
    // zero, would read as "this token has no liquidity".
    stubFetch(() => ({ status: 200, body: { [USDC.toLowerCase()]: priceEntry } }));

    const provider = new CoinGeckoMarketDataProvider();
    const [entry] = await provider.getTokenData({ chainId: 8453, tokenAddresses: [USDC] });

    expect(entry?.liquidityUsd).toBeNull();
    expect(entry?.priceUsd).not.toBeNull();
  });
});
