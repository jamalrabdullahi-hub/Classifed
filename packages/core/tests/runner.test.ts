import { describe, expect, it } from 'vitest';
import { cloidFor, planRequote, type MakerRunnerConfig } from '../src/marketmaking/runner';

/**
 * The requote decision, in isolation.
 *
 * These assert the two rules that matter: a loss past the daily cap halts the
 * book and pulls every quote; and requoting is a diff, so an unchanged book
 * places nothing new and a crash-retried quote carries a stable id.
 */

const config: MakerRunnerConfig = {
  halfSpreadBps: 5,
  levels: 3,
  levelSize: '0.1',
  levelStepBps: 2,
  maxInventory: '10',
  maxDailyLossUsd: '50',
};

function state(overrides: Partial<Parameters<typeof planRequote>[0]['state']> = {}) {
  return {
    midPrice: '100',
    volatility: '0',
    inventory: '0',
    realizedPnlTodayUsd: '0',
    openOrders: [],
    ...overrides,
  };
}

describe('planRequote', () => {
  it('places a full ladder when nothing rests', () => {
    const plan = planRequote({ symbol: 'BTC', config, state: state() });

    expect(plan.halt).toBeNull();
    expect(plan.cancel).toHaveLength(0);
    expect(plan.place).toHaveLength(config.levels * 2);
    // Bids sit below the mid, asks above.
    const bids = plan.place.filter((q) => q.isBuy);
    const asks = plan.place.filter((q) => !q.isBuy);
    expect(bids.every((q) => Number(q.price) < 100)).toBe(true);
    expect(asks.every((q) => Number(q.price) > 100)).toBe(true);
  });

  it('is a diff: a book that already rests the desired ladder changes nothing', () => {
    const first = planRequote({ symbol: 'BTC', config, state: state() });
    const resting = first.place.map((q) => ({ cloid: q.cloid, isBuy: q.isBuy, price: q.price, size: q.size }));

    const second = planRequote({ symbol: 'BTC', config, state: state({ openOrders: resting }) });

    expect(second.halt).toBeNull();
    expect(second.cancel).toHaveLength(0);
    expect(second.place).toHaveLength(0);
  });

  it('cancels a stale quote and places the new ladder', () => {
    const stale = [{ cloid: cloidFor('BTC', true, '1'), isBuy: true, price: '1', size: '0.1' }];
    const plan = planRequote({ symbol: 'BTC', config, state: state({ openOrders: stale }) });

    expect(plan.cancel).toEqual([{ symbol: 'BTC', cloid: stale[0]!.cloid }]);
    expect(plan.place).toHaveLength(config.levels * 2);
  });

  it('halts and pulls every quote once the daily loss limit is reached', () => {
    const open = planRequote({ symbol: 'BTC', config, state: state() }).place.map((q) => ({
      cloid: q.cloid,
      isBuy: q.isBuy,
      price: q.price,
      size: q.size,
    }));
    const plan = planRequote({
      symbol: 'BTC',
      config,
      state: state({ realizedPnlTodayUsd: '-50', openOrders: open }),
    });

    expect(plan.halt).not.toBeNull();
    expect(plan.place).toHaveLength(0);
    expect(plan.cancel).toHaveLength(open.length);
  });

  it('quotes one side only when inventory is at the limit', () => {
    const plan = planRequote({ symbol: 'BTC', config, state: state({ inventory: '10' }) });

    // Long at the cap: no bids (would add more long), asks only.
    expect(plan.place.some((q) => q.isBuy)).toBe(false);
    expect(plan.place.some((q) => !q.isBuy)).toBe(true);
  });

  it('rejects a non-positive mid price', () => {
    expect(() => planRequote({ symbol: 'BTC', config, state: state({ midPrice: '0' }) })).toThrow();
  });
});
