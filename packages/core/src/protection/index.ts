/**
 * The protection engine.
 *
 * Layered exactly as §17 requires, each layer independently testable and none
 * reaching into the next:
 *
 *   zscore        percentile → z          (the tail convention lives here)
 *   volatility    candles → σ             (model-swappable, per §9)
 *   peril         z, σ, T → D, B          layer 1: what the risk is
 *   contribution  D, N, modifiers → K     layer 2: how much capital
 *   policies      the three, as one framework
 *   state         lifecycle and the audit record shape
 *
 * Layer 3 — execution — is deliberately absent. See `policies.ts`.
 */
export * from './zscore';
export * from './volatility';
export * from './peril';
export * from './contribution';
export * from './premium';
export * from './policies';
export * from './state';
