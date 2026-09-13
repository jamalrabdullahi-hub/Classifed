import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://unused';
  process.env.APP_SECRET ??= randomBytes(48).toString('base64');
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
});

// The settings rules are pure, but live in a module that imports the database.
vi.mock('@flt/db', async () => {
  const actual = await vi.importActual<typeof import('@flt/db')>('@flt/db');
  return { ...actual, prisma: {} as never };
});

import type { TradingAlgorithm } from '@flt/db';
import {
  normaliseStrategyParams,
  normaliseSubscriptionSettings,
} from '../src/services/algorithms';

/**
 * A participant's own settings on an automatic-trading subscription.
 *
 * The load-bearing rule is that a setting can narrow what the offering allows
 * and never widen it. An offering is chosen on its published leverage ceiling,
 * markets and per-trade size; a subscriber who could raise any of those would
 * be running a strategy nobody reviewed, with somebody else's name on it. These
 * bounds are also the only thing stopping a typo from sizing a real order.
 */

const offering = {
  symbols: ['BTC', 'ETH', 'SOL'],
  maxLeverage: 5,
  maxNotionalUsd: '500',
} as unknown as TradingAlgorithm;

describe('normaliseSubscriptionSettings', () => {
  it('accepts settings inside the offering and returns them in canonical form', () => {
    const settings = normaliseSubscriptionSettings(offering, {
      leverage: 3,
      symbols: ['btc', 'ETH'],
      notionalUsd: '250.50',
      maxDrawdownPct: 20,
      dailyLossUsd: '25',
    });

    expect(settings).toEqual({
      leverage: 3,
      symbols: ['BTC', 'ETH'],
      notionalUsd: '250.5',
      maxDrawdownPct: 20,
      dailyLossUsd: '25',
    });
  });

  it('treats empty input as "run the offering as published"', () => {
    expect(normaliseSubscriptionSettings(offering, {})).toEqual({});
    expect(normaliseSubscriptionSettings(offering, null)).toEqual({});
  });

  it('refuses leverage above the offering ceiling', () => {
    expect(() => normaliseSubscriptionSettings(offering, { leverage: 6 })).toThrow(/between 1x and 5x/);
  });

  it('refuses leverage below 1x', () => {
    expect(() => normaliseSubscriptionSettings(offering, { leverage: 0 })).toThrow(/between 1x and 5x/);
  });

  it('refuses a market the offering does not trade', () => {
    expect(() => normaliseSubscriptionSettings(offering, { symbols: ['BTC', 'DOGE'] })).toThrow(/DOGE/);
  });

  it('refuses an empty market selection', () => {
    expect(() => normaliseSubscriptionSettings(offering, { symbols: [] })).toThrow(/at least one market/);
  });

  it('refuses a trade size above the per-trade maximum', () => {
    expect(() => normaliseSubscriptionSettings(offering, { notionalUsd: '500.01' })).toThrow(/at most \$500/);
  });

  it('accepts a trade size exactly at the maximum', () => {
    expect(normaliseSubscriptionSettings(offering, { notionalUsd: '500' }).notionalUsd).toBe('500');
  });

  it('refuses a drawdown limit outside 0–100%', () => {
    expect(() => normaliseSubscriptionSettings(offering, { maxDrawdownPct: 0 })).toThrow(/drawdown/);
    expect(() => normaliseSubscriptionSettings(offering, { maxDrawdownPct: 101 })).toThrow(/drawdown/);
  });

  it('refuses a non-positive daily loss cap', () => {
    expect(() => normaliseSubscriptionSettings(offering, { dailyLossUsd: '0' })).toThrow(/daily loss cap/);
  });

  it('refuses an end date in the past', () => {
    expect(() =>
      normaliseSubscriptionSettings(offering, { endsAt: '2000-01-01T00:00:00Z' }),
    ).toThrow(/future/);
  });

  it('accepts a future end date and normalises it to ISO', () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(normaliseSubscriptionSettings(offering, { endsAt: future }).endsAt).toBe(future);
  });
});

describe('normaliseStrategyParams', () => {
  it('clamps knobs into their allowed ranges', () => {
    expect(normaliseStrategyParams({ lookback: 0, thresholdBps: 99_999 })).toEqual({
      lookback: 1,
      thresholdBps: 10_000,
    });
  });

  it('refuses a slow average that is not longer than the fast one', () => {
    expect(() => normaliseStrategyParams({ fast: 48, slow: 12 })).toThrow(/slow average/);
  });

  it('leaves unset knobs unset, so the strategy defaults apply', () => {
    expect(normaliseStrategyParams({})).toEqual({});
  });
});
