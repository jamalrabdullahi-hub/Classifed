import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeckoTerminalPriceHistoryProvider } from '../src/history/geckoterminal';

/**
 * The chart data adapter.
 *
 * The properties tested here are the ones a chart silently misdraws when they
 * are wrong: lightweight-charts requires strictly ascending, de-duplicated
 * timestamps and will not warn if it does not get them. The upstream API
 * returns newest-first, which is the opposite.
 */

const POOL = '0x6cdcb1c4a4d1c3c6d054b27ac5b77e89eafb971d';

function stubFetch(body: unknown, status = 200) {
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function ohlcv(list: (number | null)[][]) {
  return { data: { attributes: { ohlcv_list: list } } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const provider = new GeckoTerminalPriceHistoryProvider();

describe('GeckoTerminal price history', () => {
  it('returns candles oldest first, reversing the upstream order', async () => {
    // The API returns newest-first. A chart fed that draws backwards.
    stubFetch(
      ohlcv([
        [3_000, 3, 3.5, 2.9, 3.2, 300],
        [2_000, 2, 2.5, 1.9, 2.2, 200],
        [1_000, 1, 1.5, 0.9, 1.2, 100],
      ]),
    );

    const candles = await provider.getCandles({
      chainId: 8453,
      poolAddress: POOL,
      interval: '1h',
    });

    expect(candles.map((candle) => candle.time)).toEqual([1_000, 2_000, 3_000]);
    expect(candles[0]).toMatchObject({ open: 1, high: 1.5, low: 0.9, close: 1.2, volume: 100 });
  });

  it('drops periods the pool did not trade rather than charting them as zero', async () => {
    // A null price charted as 0 draws a spike to the axis that never happened.
    stubFetch(
      ohlcv([
        [2_000, null, null, null, null, 0],
        [1_000, 1, 1.5, 0.9, 1.2, 100],
      ]),
    );

    const candles = await provider.getCandles({
      chainId: 8453,
      poolAddress: POOL,
      interval: '1h',
    });

    expect(candles).toHaveLength(1);
    expect(candles[0]?.time).toBe(1_000);
  });

  it('treats a missing volume as zero but keeps the candle', async () => {
    // Volume is incidental; the price for that period is still real.
    stubFetch(ohlcv([[1_000, 1, 1.5, 0.9, 1.2, null]]));

    const candles = await provider.getCandles({
      chainId: 8453,
      poolAddress: POOL,
      interval: '1h',
    });

    expect(candles).toHaveLength(1);
    expect(candles[0]?.volume).toBe(0);
  });

  it('collapses duplicate timestamps', async () => {
    // Duplicates make lightweight-charts render unpredictably.
    stubFetch(
      ohlcv([
        [1_000, 1, 1.5, 0.9, 1.2, 100],
        [1_000, 1, 1.6, 0.8, 1.3, 150],
      ]),
    );

    const candles = await provider.getCandles({
      chainId: 8453,
      poolAddress: POOL,
      interval: '1h',
    });

    expect(candles).toHaveLength(1);
  });

  it('picks the deepest pool, not the first or the busiest', async () => {
    /*
     * Depth is the right tiebreak. A thin pool can post high volume during one
     * incident and would then supply a chart of its own volatility rather than
     * of the token's price.
     */
    stubFetch({
      data: [
        {
          id: 'a',
          attributes: { address: '0xaaa', name: 'AERO / WETH', reserve_in_usd: '2000000' },
          relationships: { dex: { data: { id: 'aerodrome-base' } } },
        },
        {
          id: 'b',
          attributes: { address: '0xbbb', name: 'AERO / USDC', reserve_in_usd: '30000000' },
          relationships: { dex: { data: { id: 'aerodrome-slipstream' } } },
        },
      ],
    });

    const pool = await provider.findPrimaryPool(8453, '0x940181a94A35A4569E4529A3CDfB74e38FD98631');

    expect(pool?.address).toBe('0xbbb');
    expect(pool?.dex).toBe('aerodrome-slipstream');
    expect(pool?.baseSymbol).toBe('AERO');
    expect(pool?.quoteSymbol).toBe('USDC');
  });

  it('strips the fee tier from a pool name', async () => {
    // Slipstream pools are named "AERO / USDC 1%"; the quote symbol is USDC.
    stubFetch({
      data: [
        {
          id: 'a',
          attributes: { address: '0xaaa', name: 'AERO / USDC 0.6%', reserve_in_usd: '1000' },
          relationships: { dex: { data: { id: 'aerodrome-slipstream' } } },
        },
      ],
    });

    const pool = await provider.findPrimaryPool(8453, '0x940181a94A35A4569E4529A3CDfB74e38FD98631');

    expect(pool?.quoteSymbol).toBe('USDC');
  });

  it('returns null when no pool has any liquidity', async () => {
    // No pool means no chart. The caller renders that rather than an empty axis.
    stubFetch({
      data: [
        {
          id: 'a',
          attributes: { address: '0xaaa', name: 'X / Y', reserve_in_usd: '0' },
          relationships: { dex: { data: { id: 'someswap' } } },
        },
      ],
    });

    expect(await provider.findPrimaryPool(8453, '0x0000000000000000000000000000000000000001')).toBeNull();
  });

  it('returns null for a chain it does not index', async () => {
    expect(await provider.findPrimaryPool(99_999, '0x0000000000000000000000000000000000000001')).toBeNull();
  });

  it('rejects a response whose shape it does not recognise', async () => {
    // Better to fail loudly than to draw a chart from a guess.
    stubFetch({ data: { attributes: { ohlcv_list: [[1_000, 1, 1.5]] } } });

    await expect(
      provider.getCandles({ chainId: 8453, poolAddress: POOL, interval: '1h' }),
    ).rejects.toThrow(/unexpected response/i);
  });
});
