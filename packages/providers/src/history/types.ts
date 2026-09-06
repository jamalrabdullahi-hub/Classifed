/**
 * The price history contract lives in `@flt/core/ports`, not here.
 *
 * Core owns the interface because the candle service depends on it; the
 * adapters in this directory implement it. Declaring it here instead would
 * invert that dependency and force `@flt/core` to import `@flt/providers`.
 *
 * Re-exported so adapter code can keep importing from a neighbouring module.
 */
export type {
  Candle,
  CandleInterval,
  PoolReference,
  PriceHistoryProvider,
  PriceHistoryRequest,
} from '@flt/core/ports';
export { CANDLE_INTERVALS, isCandleInterval } from '@flt/core/ports';
