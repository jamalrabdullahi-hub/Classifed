/**
 * The perpetual venue contract lives in `@flt/core/ports`, not here.
 *
 * Same reasoning as the DEX adapters: core owns the interface because the perp
 * order service depends on it, and the adapters in this directory implement it.
 *
 * Re-exported so adapter code can keep importing from a neighbouring module.
 */
export type {
  NormalizedVenueOrder,
  OrderPreview,
  PerpAccountRef,
  PerpAccountSummary,
  PerpIntegratorFee,
  PerpVenue,
  PrepareCloseRequest,
  PrepareLeverageRequest,
  PrepareOrderRequest,
  PreparedAction,
  ProviderMeta,
  TypedDataRequest,
  VenueAuthorization,
} from '@flt/core/ports';

export type {
  MarginMode,
  PerpMarket,
  PerpOrderIntent,
  PerpPosition,
  PerpSide,
} from '@flt/core/domain';
