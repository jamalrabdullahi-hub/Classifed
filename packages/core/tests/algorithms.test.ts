import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../src/ports/history';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://unused';
  process.env.APP_SECRET ??= randomBytes(48).toString('base64');
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
});

// The strategy functions are pure, but they live in a module that imports the
// database and the ledger. Mock `@flt/db` so importing it never builds a real
// client — the same discipline the other unit tests here keep.
vi.mock('@flt/db', async () => {
  const actual = await vi.importActual<typeof import('@flt/db')>('@flt/db');
  return { ...actual, prisma: {} as never };
});

import { AlgorithmStrategy } from '@flt/db';
import { accrueFee, computeSignal, dailyFeeFraction, readStrategyParams } from '../src/services/algorithms';
import { Decimal } from '../src/domain/money';

/**
 * Strategy evaluation.
 *
 * `computeSignal` is the one piece of new logic that decides a direction with
 * no I/O and no money — which is exactly why it is tested here in isolation. It
 * returns "what the strategy wants"; whether that is *allowed* is decided
 * elsewhere (insurance, entitlements, balance), and those guards are what the
 * runner and the ledger tests cover.
 */

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: index * 3_600,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}

const rising = (n: number) => Array.from({ length: n }, (_, i) => 100 + i);
const falling = (n: number) => Array.from({ length: n }, (_, i) => 200 - i);

describe('readStrategyParams', () => {
  it('returns the record it is given', () => {
    expect(readStrategyParams({ fast: 5, slow: 20 })).toEqual({ fast: 5, slow: 20 });
  });

  it('treats anything that is not an object as empty', () => {
    expect(readStrategyParams(null)).toEqual({});
    expect(readStrategyParams(undefined)).toEqual({});
    expect(readStrategyParams('nope')).toEqual({});
    expect(readStrategyParams([1, 2, 3])).toEqual({});
  });
});

describe('computeSignal — MA_CROSSOVER', () => {
  it('goes long when the fast average leads the slow one', () => {
    const signal = computeSignal(
      AlgorithmStrategy.MA_CROSSOVER,
      { fast: 10, slow: 30 },
      candlesFromCloses(rising(60)),
    );
    expect(signal).toEqual({ side: 'LONG', signal: 'MA_CROSSOVER_LONG' });
  });

  it('goes short when the fast average lags', () => {
    const signal = computeSignal(
      AlgorithmStrategy.MA_CROSSOVER,
      { fast: 10, slow: 30 },
      candlesFromCloses(falling(60)),
    );
    expect(signal).toEqual({ side: 'SHORT', signal: 'MA_CROSSOVER_SHORT' });
  });

  it('stays silent until the slow window is full', () => {
    expect(
      computeSignal(AlgorithmStrategy.MA_CROSSOVER, { fast: 10, slow: 30 }, candlesFromCloses(rising(20))),
    ).toBeNull();
  });
});

describe('computeSignal — MEAN_REVERSION', () => {
  it('fades a spike above the average', () => {
    const closes = [...Array.from({ length: 29 }, () => 100), 130];
    const signal = computeSignal(
      AlgorithmStrategy.MEAN_REVERSION,
      { window: 20 },
      candlesFromCloses(closes),
    );
    expect(signal).toEqual({ side: 'SHORT', signal: 'MEAN_REVERSION_SHORT' });
  });

  it('buys a dip below the average', () => {
    const closes = [...Array.from({ length: 29 }, () => 100), 70];
    const signal = computeSignal(
      AlgorithmStrategy.MEAN_REVERSION,
      { window: 20 },
      candlesFromCloses(closes),
    );
    expect(signal?.side).toBe('LONG');
  });
});

describe('computeSignal — MOMENTUM', () => {
  it('follows the sign of the lookback return', () => {
    const closes = [...Array.from({ length: 24 }, () => 100), 120];
    const signal = computeSignal(
      AlgorithmStrategy.MOMENTUM,
      { lookback: 24, thresholdBps: 100 },
      candlesFromCloses(closes),
    );
    expect(signal).toEqual({ side: 'LONG', signal: 'MOMENTUM_LONG' });
  });

  it('stays silent when the move is below the threshold', () => {
    const closes = [...Array.from({ length: 24 }, () => 100), 100.5];
    const signal = computeSignal(
      AlgorithmStrategy.MOMENTUM,
      { lookback: 24, thresholdBps: 200 },
      candlesFromCloses(closes),
    );
    expect(signal).toBeNull();
  });
});

describe('computeSignal — guards', () => {
  it('returns null for too little history', () => {
    expect(
      computeSignal(AlgorithmStrategy.MOMENTUM, { lookback: 24 }, candlesFromCloses([1, 2, 3])),
    ).toBeNull();
  });
});

describe('management fee', () => {
  it('is 2% a month of capital, pro-rated daily at 2%/31', () => {
    expect(dailyFeeFraction(200, 31).toNumber()).toBeCloseTo(0.02 / 31, 10);
  });

  it('charges ~$0.96 on a $100 base for 15 days', () => {
    const fee = accrueFee(
      new Decimal(100),
      200,
      31,
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-16T00:00:00Z'),
    );
    expect(fee.toNumber()).toBeCloseTo(0.9677, 3);
  });

  it('charges nothing over zero elapsed time', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    expect(accrueFee(new Decimal(100), 200, 31, at, at).isZero()).toBe(true);
  });
});
