import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://unused';
  process.env.APP_SECRET ??= randomBytes(48).toString('base64');
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
});

const { Decimal } = await import('../src/domain/money');
const { ValidationError } = await import('../src/domain/errors');
const { buildQuoteLadder, capitalRequired, estimateMakerEconomics } = await import(
  '../src/marketmaking/quoting'
);

const D = (v: string | number) => new Decimal(v);

const BASE = {
  midPrice: D(80_000),
  baseHalfSpread: D('0.0005'),
  volatility: D('0.019'),
  volatilityMultiple: D('0.1'),
  inventory: D(0),
  maxInventory: D(1),
  inventorySkew: D('0.002'),
  levelSize: D('0.1'),
  levels: 3,
  levelStep: D('0.0003'),
};

describe('quote ladder', () => {
  it('quotes symmetrically when flat', () => {
    const ladder = buildQuoteLadder(BASE);

    expect(ladder.bids).toHaveLength(3);
    expect(ladder.asks).toHaveLength(3);
    expect(ladder.skew.isZero()).toBe(true);

    // Touch bid and ask sit the same distance from mid.
    expect(ladder.bids[0]!.offsetBps.minus(ladder.asks[0]!.offsetBps).abs().toNumber()).toBeLessThan(
      1e-9,
    );
  });

  it('widens with volatility rather than holding a fixed spread', () => {
    const calm = buildQuoteLadder({ ...BASE, volatility: D('0.005') });
    const wild = buildQuoteLadder({ ...BASE, volatility: D('0.05') });

    expect(wild.effectiveHalfSpread.greaterThan(calm.effectiveHalfSpread)).toBe(true);
    expect(wild.asks[0]!.offsetBps.greaterThan(calm.asks[0]!.offsetBps)).toBe(true);
  });

  it('skews the whole ladder down when long, so selling is easier than buying', () => {
    const flat = buildQuoteLadder(BASE);
    const long = buildQuoteLadder({ ...BASE, inventory: D('0.5') });

    expect(long.skew.isNegative()).toBe(true);
    // Both sides move down: the ask becomes more attractive to hit, the bid less.
    expect(long.asks[0]!.price.lessThan(flat.asks[0]!.price)).toBe(true);
    expect(long.bids[0]!.price.lessThan(flat.bids[0]!.price)).toBe(true);
  });

  it('mirrors the skew when short', () => {
    const flat = buildQuoteLadder(BASE);
    const short = buildQuoteLadder({ ...BASE, inventory: D('-0.5') });

    expect(short.skew.isPositive()).toBe(true);
    // Both sides move up relative to flat, so buying back is easier than
    // selling more. Compared against flat rather than against a fixed distance
    // from mid: the bid is still below mid either way, and the fixed threshold
    // was testing the spread rather than the skew.
    expect(short.bids[0]!.price.greaterThan(flat.bids[0]!.price)).toBe(true);
    expect(short.asks[0]!.price.greaterThan(flat.asks[0]!.price)).toBe(true);
  });

  it('stops bidding at the long limit and stops offering at the short limit', () => {
    const maxLong = buildQuoteLadder({ ...BASE, inventory: D(1) });
    expect(maxLong.bids).toHaveLength(0);
    expect(maxLong.asks.length).toBeGreaterThan(0);
    expect(maxLong.suppressed.bids).toMatch(/not bidding/);

    const maxShort = buildQuoteLadder({ ...BASE, inventory: D(-1) });
    expect(maxShort.asks).toHaveLength(0);
    expect(maxShort.bids.length).toBeGreaterThan(0);
    expect(maxShort.suppressed.asks).toMatch(/not offering/);
  });

  it('clips inventory past the limit rather than skewing through the mid', () => {
    // A fill can straddle the limit; an unclipped ratio would push the ladder
    // to the wrong side of the market.
    const over = buildQuoteLadder({ ...BASE, inventory: D(5) });
    expect(over.inventoryRatio.toNumber()).toBe(1);
    expect(over.bids).toHaveLength(0);
  });

  it('steps each level further out', () => {
    const ladder = buildQuoteLadder(BASE);
    for (let i = 1; i < ladder.asks.length; i += 1) {
      expect(ladder.asks[i]!.offsetBps.greaterThan(ladder.asks[i - 1]!.offsetBps)).toBe(true);
      expect(ladder.bids[i]!.offsetBps.greaterThan(ladder.bids[i - 1]!.offsetBps)).toBe(true);
    }
  });

  it('never quotes a bid at or below zero', () => {
    // An absurd spread must drop the level, not emit a negative price.
    const ladder = buildQuoteLadder({ ...BASE, baseHalfSpread: D(2) });
    for (const bid of ladder.bids) expect(bid.price.greaterThan(0)).toBe(true);
  });

  it('refuses impossible inputs', () => {
    expect(() => buildQuoteLadder({ ...BASE, midPrice: D(0) })).toThrow(ValidationError);
    expect(() => buildQuoteLadder({ ...BASE, maxInventory: D(0) })).toThrow(ValidationError);
    expect(() => buildQuoteLadder({ ...BASE, levels: 0 })).toThrow(ValidationError);
    expect(() => buildQuoteLadder({ ...BASE, levels: 50 })).toThrow(ValidationError);
  });
});

describe('capital', () => {
  it('sizes against full inventory, not against one level', () => {
    const requirement = capitalRequired({
      maxInventory: D(1),
      price: D(80_000),
      leverage: 5,
    });

    expect(requirement.maxNotional.toNumber()).toBe(80_000);
    expect(requirement.marginRequired.toNumber()).toBe(16_000);
    // Margin alone is liquidated by the move that filled the book.
    expect(requirement.recommendedCapital.toNumber()).toBe(48_000);
  });

  it('scales down with leverage but never to nothing', () => {
    const low = capitalRequired({ maxInventory: D(1), price: D(80_000), leverage: 1 });
    const high = capitalRequired({ maxInventory: D(1), price: D(80_000), leverage: 10 });

    expect(high.marginRequired.lessThan(low.marginRequired)).toBe(true);
    expect(high.marginRequired.greaterThan(0)).toBe(true);
  });

  it('refuses leverage below 1', () => {
    expect(() =>
      capitalRequired({ maxInventory: D(1), price: D(80_000), leverage: 0 }),
    ).toThrow(ValidationError);
  });
});

describe('economics', () => {
  const CAPITAL = D(48_000);

  it('earns the half-spread twice per round trip', () => {
    const result = estimateMakerEconomics({
      filledNotional: D(1_000_000),
      effectiveHalfSpread: D('0.001'),
      volatility: D(0),
      adverseSelectionFactor: D(0),
      makerFeeBps: 0,
      capital: CAPITAL,
    });

    expect(result.edgePerRoundTrip.toNumber()).toBeCloseTo(0.002, 12);
    expect(result.grossSpread.toNumber()).toBe(2_000);
    expect(result.netProfit.toNumber()).toBe(2_000);
  });

  it('is destroyed by adverse selection when the spread is too thin', () => {
    // 5 bps of spread against a 1.9% daily move: the informed flow takes far
    // more than the spread earns, which is how an under-priced book bleeds.
    const result = estimateMakerEconomics({
      filledNotional: D(1_000_000),
      effectiveHalfSpread: D('0.0005'),
      volatility: D('0.019'),
      adverseSelectionFactor: D('0.1'),
      makerFeeBps: 0,
      capital: CAPITAL,
    });

    expect(result.adverseSelectionCost.toNumber()).toBe(1_900);
    expect(result.netProfit.isNegative()).toBe(true);
  });

  it('charges the venue fee on both legs', () => {
    const free = estimateMakerEconomics({
      filledNotional: D(1_000_000),
      effectiveHalfSpread: D('0.002'),
      volatility: D(0),
      adverseSelectionFactor: D(0),
      makerFeeBps: 0,
      capital: CAPITAL,
    });
    const charged = estimateMakerEconomics({
      filledNotional: D(1_000_000),
      effectiveHalfSpread: D('0.002'),
      volatility: D(0),
      adverseSelectionFactor: D(0),
      makerFeeBps: 2,
      capital: CAPITAL,
    });

    // Two legs at 2 bps on a million.
    expect(free.netProfit.minus(charged.netProfit).toNumber()).toBe(400);
  });

  it('reports return against capital, which is the only comparable number', () => {
    const result = estimateMakerEconomics({
      filledNotional: D(1_000_000),
      effectiveHalfSpread: D('0.002'),
      volatility: D('0.019'),
      adverseSelectionFactor: D('0.05'),
      makerFeeBps: 0,
      capital: CAPITAL,
    });

    // 4000 gross - 950 adverse = 3050 on 48000.
    expect(result.netProfit.toNumber()).toBeCloseTo(3_050, 6);
    expect(result.returnOnCapital.toNumber()).toBeCloseTo(3_050 / 48_000, 9);
  });

  it('cannot divide by zero capital', () => {
    const result = estimateMakerEconomics({
      filledNotional: D(1_000),
      effectiveHalfSpread: D('0.001'),
      volatility: D(0),
      adverseSelectionFactor: D(0),
      makerFeeBps: 0,
      capital: D(0),
    });
    expect(result.returnOnCapital.toNumber()).toBe(0);
  });
});
