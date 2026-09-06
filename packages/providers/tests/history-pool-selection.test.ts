import { describe, expect, it, vi, afterEach } from 'vitest';
import { GeckoTerminalPriceHistoryProvider } from '../src/history/geckoterminal';

/**
 * Which pool a chart is drawn from.
 *
 * A candle from a pool is a ratio, not a price. Picking the deepest pool
 * regardless of what sits on the other side of it produces a chart of the
 * counter-asset's volatility, and the failure is silent — the line renders
 * perfectly and simply describes the wrong thing.
 *
 * The case that exposed this is reproduced below with the real numbers: DAI on
 * Base, whose deepest pool is against an exotic token and whose second-deepest
 * is against USDC.
 */

const TOKEN = '0xdai';

function poolsResponse(
  pools: Array<{ name: string; reserve: string; address: string; base?: string }>,
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: pools.map((pool) => ({
        id: pool.address,
        attributes: { address: pool.address, name: pool.name, reserve_in_usd: pool.reserve },
        relationships: {
          dex: { data: { id: 'uniswap_v3_base' } },
          base_token: { data: { id: `base_${pool.base ?? TOKEN}` } },
        },
      })),
    }),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pool selection', () => {
  it('prefers a stablecoin pair over a deeper exotic one', async () => {
    // The real shape of DAI on Base: the exotic pair is more than twice as deep.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        poolsResponse([
          { name: 'DAI / VCNT 0.3%', reserve: '54123.088', address: '0xexotic' },
          { name: 'DAI / USDC 0.05%', reserve: '23761.237', address: '0xstable' },
        ]),
      ),
    );

    const provider = new GeckoTerminalPriceHistoryProvider();
    const pool = await provider.findPrimaryPool(8453, TOKEN);

    expect(pool?.address).toBe('0xstable');
    expect(pool?.quoteSymbol).toBe('USDC');
  });

  it('refuses a pool where the token is the quote, however deep it is', async () => {
    /*
     * The real DAI-on-Base case. Its deepest listed pool is USDXSMART/DAI at
     * roughly $106k — more than four times the deepest DAI/USDC pool — and
     * charting it plots USDXSMART priced in DAI rather than DAI at all.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        poolsResponse([
          { name: 'USDXSMART / DAI', reserve: '106144.96', address: '0xinverted', base: '0xusdxsmart' },
          { name: 'DAI / USDC 0.05%', reserve: '23758', address: '0xstable' },
        ]),
      ),
    );

    const provider = new GeckoTerminalPriceHistoryProvider();
    const pool = await provider.findPrimaryPool(8453, TOKEN);

    expect(pool?.address).toBe('0xstable');
  });

  it('returns nothing rather than a pool that prices a different asset', async () => {
    // No chart is honest. A chart of somebody else's price is not.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        poolsResponse([
          { name: 'USDXSMART / DAI', reserve: '106144.96', address: '0xinverted', base: '0xusdxsmart' },
        ]),
      ),
    );

    const provider = new GeckoTerminalPriceHistoryProvider();
    expect(await provider.findPrimaryPool(8453, TOKEN)).toBeNull();
  });

  it('prefers a major pair over an exotic one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        poolsResponse([
          { name: 'FOO / SOMECOIN', reserve: '900000', address: '0xexotic' },
          { name: 'FOO / WETH 0.3%', reserve: '120000', address: '0xmajor' },
        ]),
      ),
    );

    const provider = new GeckoTerminalPriceHistoryProvider();
    expect((await provider.findPrimaryPool(8453, TOKEN))?.address).toBe('0xmajor');
  });

  it('falls back to depth within the same tier', async () => {
    // Both quoted in stables, so the deeper one is genuinely the better chart.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        poolsResponse([
          { name: 'AERO / USDC 0.05%', reserve: '2000000', address: '0xdeep' },
          { name: 'AERO / USDT 0.05%', reserve: '50000', address: '0xshallow' },
        ]),
      ),
    );

    const provider = new GeckoTerminalPriceHistoryProvider();
    expect((await provider.findPrimaryPool(8453, TOKEN))?.address).toBe('0xdeep');
  });

  it('still returns an exotic pool when nothing better exists', async () => {
    // A thin chart beats no chart, as long as it was not chosen over a good one.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        poolsResponse([{ name: 'FOO / SOMECOIN', reserve: '4200', address: '0xonly' }]),
      ),
    );

    const provider = new GeckoTerminalPriceHistoryProvider();
    expect((await provider.findPrimaryPool(8453, TOKEN))?.address).toBe('0xonly');
  });
});
