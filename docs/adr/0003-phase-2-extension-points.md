# ADR 0003 — Phase 2 extension points

**Status:** Accepted · **Date:** 2026-09-05

## Context

Phase 2 will add a risk engine, an insurance engine and derivatives. The brief
requires that this be possible without replacing the core trading architecture,
while also requiring that none of it be built now.

## Decision

Phase 1 defines interfaces and calls them with no-op implementations, rather
than leaving comments describing where code will go later.

| Extension point | Phase 1 state |
|---|---|
| `RiskEngine.assessTrade()` | `NoopRiskEngine` returns `allow`. **Called** by the quote service on every quote. |
| `InsuranceProvider` | Interface defined. Not wired into any path. |
| `users.accountType` | Column exists, `INVESTOR \| TRADER \| INSTITUTION`, defaults to `INVESTOR`. Read by the fee resolver and passed to the risk engine. |

The distinction matters: because `assessTrade` is already on the quote path,
Phase 2 replaces one line in the provider registry. If it were only a comment,
Phase 2 would have to thread a new call site through the trade services and
re-test the whole path.

## Explicitly not built

No margin, leverage, perpetuals, liquidation, position insurance, premium
calculation, PDT-style restrictions or volatility modelling. No database tables
for any of it — schema for an unbuilt engine would be guesswork.
