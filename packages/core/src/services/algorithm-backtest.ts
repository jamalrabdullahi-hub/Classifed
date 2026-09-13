import { AlgorithmStrategyType, type AlgorithmStrategy } from '@flt/db';
import type { Candle } from '../ports/history';
import { Decimal } from '../domain/money';
import { evaluateStrategy, type CompositeSpec, type StrategyParams } from './algorithms';

/**
 * Backtesting.
 *
 * A calculator, not a promise. It replays a deterministic strategy over the
 * candles it is given and reports what that strategy *would* have returned at a
 * chosen leverage and account size — so a participant can see how leverage cuts
 * both ways before committing capital.
 *
 * Deliberately simplified and honest about it: no fees, no funding, no
 * slippage, and it acts on the close of each bar. Those omissions flatter the
 * result, which is why the numbers are presented as an illustration of the
 * strategy's shape, never a forecast. The AI offering cannot be backtested this
 * way cheaply (each bar would be an LLM call), so the AI page uses the same
 * calculator over a representative strategy and says so.
 */

export interface BacktestInput {
  strategyType?: AlgorithmStrategyType;
  strategy: AlgorithmStrategy;
  params: StrategyParams;
  composition?: CompositeSpec | null;
  expression?: string | null;
  /** Oldest first, newest last. */
  candles: Candle[];
  leverage: number;
  accountSize: string | number | Decimal;
}

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface BacktestResult {
  startEquity: string;
  endEquity: string;
  returnPct: string;
  maxDrawdownPct: string;
  trades: number;
  winRate: string;
  bars: number;
  equityCurve: EquityPoint[];
}

/**
 * Replays the strategy. Long/short per the signal, flipping when it changes,
 * holding the last direction when the strategy is silent.
 */
export function backtest(input: BacktestInput): BacktestResult {
  const startEquity = new Decimal(input.accountSize);
  const leverage = Math.max(1, Math.floor(input.leverage));
  const candles = input.candles.filter((candle) => Number.isFinite(candle.close));

  const empty: BacktestResult = {
    startEquity: startEquity.toFixed(2),
    endEquity: startEquity.toFixed(2),
    returnPct: '0.00',
    maxDrawdownPct: '0.00',
    trades: 0,
    winRate: '0.00',
    bars: candles.length,
    equityCurve: [],
  };
  if (candles.length < 4) return empty;

  let equity = startEquity;
  let peak = startEquity;
  let maxDrawdown = new Decimal(0);
  let direction = 0; // +1 long, -1 short, 0 flat
  let entryEquity = startEquity;
  let trades = 0;
  let wins = 0;

  const curve: EquityPoint[] = [{ time: candles[0]!.time, equity: equity.toNumber() }];

  for (let i = 1; i < candles.length; i += 1) {
    const signal = evaluateStrategy(
      {
        strategyType: input.strategyType ?? AlgorithmStrategyType.BUILTIN,
        strategy: input.strategy,
        params: input.params,
        composition: input.composition ?? null,
        expression: input.expression ?? null,
      },
      candles.slice(0, i + 1),
    );
    const next = signal ? (signal.side === 'LONG' ? 1 : -1) : direction;

    if (next !== direction) {
      // Close the previous trade.
      if (direction !== 0) {
        trades += 1;
        if (equity.greaterThan(entryEquity)) wins += 1;
      }
      direction = next;
      entryEquity = equity;
    }

    // Bar return, applied with leverage in the held direction.
    const prev = candles[i - 1]!.close;
    const barReturn = prev === 0 ? 0 : (candles[i]!.close - prev) / prev;
    equity = equity.times(new Decimal(1).plus(new Decimal(barReturn).times(direction).times(leverage)));
    if (equity.lessThan(0)) equity = new Decimal(0); // liquidated

    if (equity.greaterThan(peak)) peak = equity;
    const drawdown = peak.isZero() ? new Decimal(0) : peak.minus(equity).dividedBy(peak);
    if (drawdown.greaterThan(maxDrawdown)) maxDrawdown = drawdown;

    // Sample the curve to keep the payload small (max ~240 points).
    const step = Math.max(1, Math.floor(candles.length / 240));
    if (i % step === 0 || i === candles.length - 1) {
      curve.push({ time: candles[i]!.time, equity: equity.toNumber() });
    }
  }

  if (direction !== 0) {
    trades += 1;
    if (equity.greaterThan(entryEquity)) wins += 1;
  }

  const returnPct = startEquity.isZero()
    ? new Decimal(0)
    : equity.minus(startEquity).dividedBy(startEquity).times(100);

  return {
    startEquity: startEquity.toFixed(2),
    endEquity: equity.toFixed(2),
    returnPct: returnPct.toFixed(2),
    maxDrawdownPct: maxDrawdown.times(100).toFixed(2),
    trades,
    winRate: trades === 0 ? '0.00' : new Decimal(wins).dividedBy(trades).times(100).toFixed(2),
    bars: candles.length,
    equityCurve: curve,
  };
}
