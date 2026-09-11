# ADR 0005 — Perpetuals under custody

**Status:** Accepted · **Date:** 2026-09-11
**Depends on:** ADR 0004 (custodial omnibus)

## Context

ADR 0004 moved spot trading, deposits and withdrawals onto the custodial omnibus:
FLT holds the funds, the ledger is the source of truth, and FLT signs from the
omnibus. Perpetuals were deliberately left out — today a perp order is built for
the *participant's* wallet and signed in-browser, optionally with a session agent
key (`apps/web/src/lib/hyperliquid-agent.ts`). Hyperliquid signs L1 actions over a
chain id wallets refuse, which is why an agent key exists at all.

Perps differ from spot under custody in three ways: **collateral is venue-side**
(Hyperliquid holds margin, not the omnibus EVM wallet); an **agent key is a
trading credential** (can place/cancel, cannot withdraw); and **positions live at
the venue**, so the ledger can't see them without a venue-side read.

## Decision

**Perpetuals run on the custodian model.** For perps, as for spot, FLT holds
everything and the participant holds nothing:

- **The omnibus funds and holds the venue collateral.** There is one FLT-owned
  Hyperliquid account, funded from `CLIENT_OMNIBUS` (USDC on
  Hyperliquid/Arbitrum — off-Base, unlike the spot wallet). Participants never
  fund a venue account; their margin is an internal `USER_LOCKED` balance.
- **The omnibus holds the agent key.** FLT authorises an agent key for that
  Hyperliquid account — the omnibus signs the EIP-712 authorisation through
  Privy (`managedAccountFor` → `createViemAccount`) — and stores it
  **server-side, encrypted at rest** (AES-256-GCM, like MFA secrets). FLT uses
  it to place and cancel the orders each participant initiates. It can trade the
  account and **cannot withdraw**; that bound is enforced by Hyperliquid, not by
  us, and the key is revocable.
- **Participants never connect a wallet, never sign, and never hold a key.** A
  perp order is built for the FLT venue account, not a participant wallet; the
  `PerpOrder` row records which participant each position belongs to.

This is a **second deliberate custody exception**, after the omnibus itself. It
supersedes the earlier "no server-side trading key" position. A browser/session
agent key (never transmitted) was considered and **rejected**, because it
requires a participant wallet and browser signing — exactly the non-custodial
model the product moved away from.

## Consequences

- **Key custody is now the highest-value secret in the system.** The agent key
  can trade the pooled Hyperliquid account. It must be encrypted at rest, never
  logged, and have an explicit revocation path. A leak is incident-severity.
- **Two new surfaces.** Venue-side collateral is a second place funds live, and
  positions are a second thing reconciliation must read. A **venue-side
  reconciliation leg** (per-account margin + open positions at Hyperliquid vs
  the ledger's perp liabilities) is required, on the same rule as ADR 0004:
  alert on divergence, never auto-adjust.
- **Collateral movement is a ledger event.** Funding the venue is a movement out
  of `CLIENT_OMNIBUS`; the participant's margin is a `USER_LOCKED` balance.
- Protection (the insurance engine) already sits on the perp path and is
  unaffected by who holds the key.

## Not built yet

No server-held agent key, no venue-funded collateral, no perp ledger settlement,
and no venue-side reconciliation exist today. This ADR authorises building them
(step 7 of the custody plan). `PERPS_ENABLED=true` + `PERP_VENUE=hyperliquid` are
set; the venue read path is verified live (234 markets, BTC listed).
