# ADR 0002 — DEX routing behind an abstraction

**Status:** Accepted · **Date:** 2026-09-05

## Context

Phase 1 sources liquidity through the 0x Swap API v2. We will need additional
aggregators, direct DEX integrations and additional chains later, and none of
those should require touching the frontend or the trade services.

## Decision

All routing goes through the `DEXRouter` interface in
`packages/providers/src/dex/types.ts`. `packages/providers/src/registry.ts` is
the only module in the codebase permitted to name a concrete vendor.

Two adapters ship in Phase 1:

- `ZeroExRouter` — the real integration against 0x Swap API v2.
- `MockRouter` — deterministic, seeded, no network. Lets the entire interface
  and test suite run without an API key.

The active router is selected by `DEX_ROUTER` and gated at runtime by the
`dex_providers` table, so an administrator can disable a provider without a
deployment.

## Notes on the 0x v2 contract

- Endpoint: `GET https://api.0x.org/swap/allowance-holder/{price,quote}`
  with headers `0x-api-key` and `0x-version: v2`.
- The `transaction` object in a quote response is the unsigned transaction the
  user's wallet signs. This is what makes the non-custodial model work.
- **v2 does not return price impact.** v1's `estimatedPriceImpact` was removed.
  We compute it by comparing the execution rate against a small-notional
  reference quote, and label it an estimate in the interface.
- Integrator fees are native: `swapFeeBps` (max 1000), `swapFeeRecipient`,
  `swapFeeToken` (must be the buy or sell token).
- Allowances are set on the address in `allowanceTarget` (AllowanceHolder) and
  never on the Settler contract.

## Consequences

Adding an aggregator is a new directory under `src/dex/` plus one line in the
registry. No business logic or UI changes.
