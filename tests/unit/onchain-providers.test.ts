import { beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from '../../src/domain/money';
import { MockDexProvider } from '../../src/providers/dex/mock';
import { MockScreeningProvider } from '../../src/providers/screening/mock';
import { mockScenarios } from '../../src/providers/mock-support';

/**
 * Contract tests for the on-chain providers. A real aggregator or analytics
 * adapter must satisfy these too — they encode what the routing engine and the
 * screening policy depend on, independent of vendor.
 */

const ALLOWED = ['mock-agg-sol', 'mock-amm-sol'];

async function solRoutes(dex: MockDexProvider, amountIn: string, maxImpactBps?: number) {
  return dex.getRoutes({
    chain: 'solana',
    fromSymbol: 'USDC',
    toSymbol: 'SOL',
    amountIn,
    allowedProtocols: ALLOWED,
    maxPriceImpactBps: maxImpactBps,
  });
}

describe('DexProvider contract', () => {
  let dex: MockDexProvider;

  beforeEach(() => {
    mockScenarios.clear();
    dex = new MockDexProvider('test-seed');
  });

  it('returns several routes, ranked best-first', async () => {
    const routes = await solRoutes(dex, '1000');

    expect(routes.data.length).toBeGreaterThan(1);
    for (let i = 1; i < routes.data.length; i += 1) {
      const previous = new Decimal(routes.data[i - 1]!.expectedOut);
      const current = new Decimal(routes.data[i]!.expectedOut);
      expect(previous.gte(current)).toBe(true);
    }
  });

  it('quotes amounts as decimal strings, never numbers', async () => {
    const route = (await solRoutes(dex, '1000')).data[0]!;
    expect(typeof route.expectedOut).toBe('string');
    expect(typeof route.estimatedGasNative).toBe('string');
    expect(new Decimal(route.expectedOut).isPositive()).toBe(true);
  });

  it('reports price impact that grows superlinearly with size', async () => {
    const small = (await solRoutes(dex, '1000')).data[0]!;
    const large = (await solRoutes(dex, '500000')).data[0]!;

    expect(large.priceImpactBps).toBeGreaterThan(small.priceImpactBps);
    // 500x the size should cost far more than 500x nothing — the point of caps.
    expect(large.priceImpactBps).toBeGreaterThan(small.priceImpactBps * 10);
  });

  it('filters out routes above the caller impact cap', async () => {
    const routes = await solRoutes(dex, '500000', 1);
    expect(routes.data).toHaveLength(0);
  });

  it('returns nothing when no protocol is permitted', async () => {
    const routes = await dex.getRoutes({
      chain: 'solana',
      fromSymbol: 'USDC',
      toSymbol: 'SOL',
      amountIn: '1000',
      allowedProtocols: [],
    });
    expect(routes.data).toHaveLength(0);
  });

  it('predicts a revert when the floor cannot be met', async () => {
    const route = (await solRoutes(dex, '1000')).data[0]!;
    const impossible = new Decimal(route.expectedOut).times(2).toFixed();

    const simulation = await dex.simulate(route.routeId, impossible);
    expect(simulation.data.outcome).toBe('WOULD_REVERT');
    expect(simulation.data.revertReason).toBeTruthy();
  });

  it('predicts success when the floor is achievable', async () => {
    const route = (await solRoutes(dex, '1000')).data[0]!;
    const achievable = new Decimal(route.expectedOut).times('0.99').toFixed();

    const simulation = await dex.simulate(route.routeId, achievable);
    expect(simulation.data.outcome).toBe('WOULD_SUCCEED');
  });

  it('submits one transaction for a repeated idempotency key', async () => {
    const route = (await solRoutes(dex, '1000')).data[0]!;
    const input = {
      idempotencyKey: 'swap-1',
      routeId: route.routeId,
      chain: 'solana',
      fromSymbol: 'USDC',
      toSymbol: 'SOL',
      amountIn: '1000',
      minAmountOut: new Decimal(route.expectedOut).times('0.99').toFixed(),
      fromAddress: 'HotWallet',
      deadline: new Date(Date.now() + 60_000),
      private: true,
    };

    const first = await dex.submit(input);
    const second = await dex.submit(input);

    expect(second.data.externalId).toBe(first.data.externalId);
    expect(second.data.txHash).toBe(first.data.txHash);
  });

  it('reverts rather than filling below the floor, keeping the input', async () => {
    mockScenarios.set('mock', 'ADVERSE_PRICE_MOVE');
    const route = (await solRoutes(dex, '1000')).data[0]!;

    const receipt = await dex.submit({
      idempotencyKey: 'swap-2',
      routeId: route.routeId,
      chain: 'solana',
      fromSymbol: 'USDC',
      toSymbol: 'SOL',
      amountIn: '1000',
      // A floor the moved market cannot satisfy.
      minAmountOut: route.expectedOut,
      fromAddress: 'HotWallet',
      deadline: new Date(Date.now() + 60_000),
      private: false,
    });

    expect(receipt.data.status).toBe('REVERTED');
    expect(receipt.data.amountOut).toBeUndefined();
  });

  it('takes less slippage privately than publicly under an adverse move', async () => {
    mockScenarios.set('mock', 'ADVERSE_PRICE_MOVE');
    const route = (await solRoutes(dex, '1000')).data[0]!;
    const floor = new Decimal(route.expectedOut).times('0.5').toFixed();

    const base = {
      routeId: route.routeId,
      chain: 'solana',
      fromSymbol: 'USDC',
      toSymbol: 'SOL',
      amountIn: '1000',
      minAmountOut: floor,
      fromAddress: 'HotWallet',
      deadline: new Date(Date.now() + 60_000),
    };

    const publicFill = await dex.submit({ ...base, idempotencyKey: 'pub', private: false });
    const privateFill = await dex.submit({ ...base, idempotencyKey: 'priv', private: true });

    // This difference is the entire argument for protected submission.
    expect(
      new Decimal(privateFill.data.amountOut!).gt(new Decimal(publicFill.data.amountOut!)),
    ).toBe(true);
  });

  it('refuses a submission whose deadline has already passed', async () => {
    const route = (await solRoutes(dex, '1000')).data[0]!;

    await expect(
      dex.submit({
        idempotencyKey: 'swap-late',
        routeId: route.routeId,
        chain: 'solana',
        fromSymbol: 'USDC',
        toSymbol: 'SOL',
        amountIn: '1000',
        minAmountOut: '1',
        fromAddress: 'HotWallet',
        deadline: new Date(Date.now() - 1000),
        private: true,
      }),
    ).rejects.toThrow(/deadline/i);
  });

  it('refuses to price an asset it has no pool for', async () => {
    await expect(
      dex.getRoutes({
        chain: 'solana',
        fromSymbol: 'USDC',
        toSymbol: 'NOTAREALTOKEN',
        amountIn: '1000',
        allowedProtocols: ALLOWED,
      }),
    ).rejects.toThrow(/no pool/i);
  });
});

describe('ScreeningProvider contract', () => {
  let screening: MockScreeningProvider;

  beforeEach(() => {
    mockScenarios.clear();
    screening = new MockScreeningProvider();
  });

  it('is deterministic for the same address', async () => {
    const first = await screening.screenAddress({
      address: '0xabc',
      chain: 'ethereum',
      direction: 'INBOUND',
    });
    const second = await screening.screenAddress({
      address: '0xabc',
      chain: 'ethereum',
      direction: 'INBOUND',
    });
    expect(second.data.risk).toBe(first.data.risk);
  });

  it('reports direct sanctions exposure and recommends rejection', async () => {
    mockScenarios.set('mock', 'SCREENING_SEVERE');
    const verdict = await screening.screenAddress({
      address: '0xbad',
      chain: 'ethereum',
      direction: 'INBOUND',
    });

    expect(verdict.data.risk).toBe('SEVERE');
    expect(verdict.data.findings[0]!.category).toBe('SANCTIONS');
    expect(verdict.data.findings[0]!.hops).toBe(0);
    expect(verdict.data.decision).toBe('REJECT');
  });

  it('reports indirect exposure with a hop count', async () => {
    mockScenarios.set('mock', 'SCREENING_HIGH_RISK');
    const verdict = await screening.screenAddress({
      address: '0xrisky',
      chain: 'ethereum',
      direction: 'INBOUND',
    });

    expect(verdict.data.risk).toBe('HIGH');
    expect(verdict.data.findings[0]!.hops).toBeGreaterThan(0);
  });

  it('gives every verdict an expiry, so a clean answer goes stale', async () => {
    const verdict = await screening.screenAddress({
      address: '0xdef',
      chain: 'ethereum',
      direction: 'INBOUND',
    });

    expect(verdict.data.expiresAt).toBeInstanceOf(Date);
    expect(verdict.data.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns no findings for a clean address', async () => {
    screening.setRisk('0xclean', 'LOW');
    const verdict = await screening.screenAddress({
      address: '0xclean',
      chain: 'ethereum',
      direction: 'INBOUND',
    });

    expect(verdict.data.findings).toEqual([]);
    expect(verdict.data.decision).toBe('ACCEPT');
  });

  it('screens transactions as well as addresses', async () => {
    const verdict = await screening.screenTransaction({
      txHash: '0xhash',
      chain: 'ethereum',
      address: '0xabc',
    });
    expect(verdict.data.subject).toBe('0xabc');
  });
});
