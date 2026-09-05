/**
 * The DEX routing contract lives in `@flt/core/ports`, not here.
 *
 * Core owns the interface because the quote service depends on it; the adapters
 * in this directory implement it. Declaring it here instead would invert that
 * dependency and force `@flt/core` to import `@flt/providers`.
 *
 * Re-exported so adapter code can keep importing from a neighbouring module.
 */
export type {
  DEXRouter,
  FirmQuote,
  IndicativePrice,
  IntegratorFee,
  PriceRequest,
  ProviderMeta,
  QuoteRequest,
  RouteFill,
  RouteSummary,
  TokenTax,
  UnsignedTransaction,
} from '@flt/core/ports';
