# ADR 0006 — Perpetual accounting policy

**Status:** Accepted · **Date:** 2026-09-11
**Depends on:** ADR 0004 (custodial omnibus), ADR 0005 (perps under custody)

## Context

ADR 0005 put perps under custody: the omnibus funds the venue and holds the
agent key. It left the **accounting model** open — how a participant's perp
order maps to the pooled venue account, when margin is reserved, and how PnL
reaches the ledger. This ADR fixes that, so slice 4 (ledger settlement) and
slice 6 (execution) can be built against a decided model instead of guesses.

The ledger's rules are unchanged from ADR 0004: double entry, a reference for
idempotency, alert-never-auto-adjust, and the sign convention (assets ≥ 0,
liabilities ≤ 0).

## Decisions

### P1 — One pooled venue account, attributed per order *(chosen)*

There is one FLT-owned Hyperliquid account, and every participant's order is
attributed to them by a `PerpOrder` row (`userId`). Positions **net** at the
venue.

- *Why:* it matches the omnibus — one account, one key, one reconciliation.
  Per-participant HL sub-accounts are real isolation but a much larger build.
- *Consequence (P10):* because positions net at the venue, the **venue's net
  position ≠ the sum of ledger positions**, and a liquidation acts on the net
  venue position, not per participant. This must be documented and reconciled,
  and is the main reason to revisit P1B.

### P2 — Isolated margin only

Only `ISOLATED`. Cross margin on a pooled account lets one participant's
adverse move liquidate another's position — unacceptable for custody. Enforced
server-side.

### P3 — Reserve margin on prepare, before broadcast

Opening locks the participant's margin (`USER_AVAILABLE → USER_LOCKED`) **before**
the order is broadcast, exactly as the spot `execute` path does. Release on
fail/revert; settle on fill. A broadcast before the lock would let the same
balance back a trade and a withdrawal.

### P4 — Two sides, as with spot

`USER_LOCKED` (the participant's committed margin) is backed by `VENUE_MARGIN`
(the pool at the venue). Same shape as `USER_AVAILABLE` backed by
`CLIENT_OMNIBUS`. No double count.

### P5 — Realized-only on the ledger *(chosen)*

The ledger books **realized** PnL (at close). An open position's unrealized PnL
is **not** on the ledger; it is shown to the participant as a **separate,
venue-sourced, clearly-labelled figure**, never folded into their balance.

- *Why:* the ledger stays a record of *settled* facts, which is what makes it
  trustworthy. Marking to market every interval means mark-timing disputes and
  double-booking risk against the close entry.
- *Consequence:* `VENUE_MARGIN` (ledger) and the venue account value differ by
  the open unrealized PnL. That difference is **expected** and is what the venue
  reconciliation reports as a surplus, not a divergence to correct.

### P6 — Funding folded into realized PnL

HL funding (hourly, realized over time) is folded into the position's realized
PnL at close, consistent with P5. A periodic funding entry is a later refinement.

### P7 — Liquidation is a close

A liquidation is a close with `pnl = −margin` (isolated margin bounds the loss)
plus any liquidation fee, routed through the same settlement path. No special
case.

### P8 — A PLATFORM_EQUITY account absorbs pooled residual

A `PLATFORM_EQUITY` ledger account absorbs any pooled **shortfall** (a loss past
liquidation, or a venue outage) and any unexplained surplus, so participant
balances are **never socialized or haircut**. Reconciliation flags an equity
drawdown, not "client funds missing".

### P9 — Fees booked at close

HL charges per order (open and close); the participant's total fee is booked
into `FEE_REVENUE` at close, matching P5's realized timing.

### P11 — Spot ↔ perp movement

Funding the venue is `DR VENUE_MARGIN / CR CLIENT_OMNIBUS` (built, slice 4).
Moving a participant's balance into a perp is just the `USER_AVAILABLE →
USER_LOCKED` lock (the pool is already funded). Returning it on close is
`settlePerpRealized`.

## Consequences

- Slice 4 gains: participant attribution (`PerpOrder` per user), margin lock on
  prepare, settlement on fill, and a `PLATFORM_EQUITY` account kind.
- Slice 6's server execution places the order for the omnibus and locks the
  **participant's** margin — trading with no participant attributable is now
  explicitly forbidden (it is the "promised twice" failure the ledger exists to
  prevent).
- The ledger carries no open PnL, so the UI must source unrealized PnL from the
  venue and label it.

## Post-launch considerations (decided to revisit)

Recorded here so the deferral is a decision, not an oversight:

- **Consider P1B — per-participant HL sub-accounts.** Removes netting (P10) and
  gives true margin isolation, at the cost of per-user provisioning, routing,
  and reconciliation. Revisit when a participant's notional or the pool's net
  risk makes shared-account netting unacceptable.
- **Consider P5B — periodic mark-to-market.** Posting unrealized PnL to a
  dedicated account on an interval, so a participant's ledger balance reflects
  live PnL. Needed if the ledger must enforce margin calls itself. Revisit when
  the product needs balances (not just a labelled figure) to carry unrealized
  PnL.
