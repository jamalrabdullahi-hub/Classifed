import { createHash } from 'node:crypto';
import { Decimal } from '../domain/money';

/**
 * Shared machinery for the mock adapters.
 *
 * Mocks are deterministic: the same seed and the same inputs give the same
 * prices and fills, every run. Tests that need a specific failure mode ask for
 * it explicitly via `scenarios` rather than hoping randomness produces it.
 */

/** Deterministic PRNG (mulberry32) seeded from a string. */
export function seededRandom(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Indicative reference prices, in USD.
 *
 * These are fabricated numbers for a mock. They are NOT a price feed and must
 * never be used to quote a real customer — the real LiquidityProvider adapter
 * supplies live prices.
 */
export const MOCK_REFERENCE_PRICES: Record<string, string> = {
  BTC: '64000',
  ETH: '3200',
  SOL: '145',
  USDT: '1',
  USDC: '1',
};

/**
 * A stable price that drifts slowly with the clock, so successive quotes differ
 * (exercising expiry and slippage paths) without being unpredictable: the drift
 * is a pure function of the seed and the current 10-second bucket.
 */
export function mockPrice(symbol: string, seed: string, at: Date = new Date()): Decimal {
  const base = MOCK_REFERENCE_PRICES[symbol];
  if (!base) {
    throw new Error(`Mock provider has no reference price for ${symbol}`);
  }
  // Stablecoins do not drift.
  if (symbol === 'USDT' || symbol === 'USDC') return new Decimal(base);

  const bucket = Math.floor(at.getTime() / 10_000);
  const rand = seededRandom(`${seed}:${symbol}:${bucket}`)();
  // +/- 0.25% band around the reference.
  const drift = new Decimal(rand).minus('0.5').times('0.005');
  return new Decimal(base).times(new Decimal(1).plus(drift)).toDecimalPlaces(8);
}

/**
 * Forced behaviours for tests. Set a scenario, exercise the flow, clear it.
 * Never consulted in production — the mock adapters are refused there by env().
 */
export type MockScenario =
  | 'DEFAULT'
  | 'PARTIAL_FILL'
  | 'ORDER_REJECTED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_PENDING'
  | 'WITHDRAWAL_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'KYC_REJECTED'
  | 'KYC_MANUAL_REVIEW'
  // On-chain execution
  | 'SWAP_WOULD_REVERT'
  | 'ADVERSE_PRICE_MOVE'
  | 'NO_ROUTES'
  // The realistic Somali case: the OTC desk simply will not quote.
  | 'OTC_UNAVAILABLE'
  // Blockchain analytics
  | 'SCREENING_HIGH_RISK'
  | 'SCREENING_SEVERE';

class ScenarioRegistry {
  private scenarios = new Map<string, Set<MockScenario>>();

  /** Replace whatever was active for this provider. */
  set(provider: string, scenario: MockScenario): void {
    this.scenarios.set(provider, new Set([scenario]));
  }

  /**
   * Add a condition without clearing the others. Real incidents rarely arrive
   * one at a time — an unavailable counterparty AND a moving market is exactly
   * the combination worth testing.
   */
  add(provider: string, scenario: MockScenario): void {
    const current = this.scenarios.get(provider) ?? new Set<MockScenario>();
    current.add(scenario);
    this.scenarios.set(provider, current);
  }

  has(provider: string, scenario: MockScenario): boolean {
    return this.scenarios.get(provider)?.has(scenario) ?? false;
  }

  /** First active scenario, for adapters that only branch on one. */
  get(provider: string): MockScenario {
    const first = this.scenarios.get(provider)?.values().next();
    return first && !first.done ? first.value : 'DEFAULT';
  }

  clear(): void {
    this.scenarios.clear();
  }
}

export const mockScenarios = new ScenarioRegistry();

/** Mock adapters keep their state in-process; this is reset between tests. */
export class MockStore<T> {
  private items = new Map<string, T>();
  private byIdempotencyKey = new Map<string, string>();

  put(id: string, value: T, idempotencyKey?: string): void {
    this.items.set(id, value);
    if (idempotencyKey) this.byIdempotencyKey.set(idempotencyKey, id);
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  findByIdempotencyKey(key: string): T | undefined {
    const id = this.byIdempotencyKey.get(key);
    return id ? this.items.get(id) : undefined;
  }

  all(): T[] {
    return [...this.items.values()];
  }

  clear(): void {
    this.items.clear();
    this.byIdempotencyKey.clear();
  }
}

export function mockExternalId(prefix: string, seedValue: string): string {
  const digest = createHash('sha256').update(seedValue).digest('hex').slice(0, 20);
  return `${prefix}_${digest}`;
}
