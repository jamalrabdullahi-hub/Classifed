# ADR 0007 — Automated market-making (the house book)

**Status:** Accepted · **Date:** 2026-09-12
**Depends on:** ADR 0004 (custodial omnibus), ADR 0005 (perps custody), ADR 0006 (perps accounting)
**Reverses:** the "no automated trading path" position in `docs/HANDOFF.md`, enforced by the removal in `81f00c4`.

## Context

`packages/core/src/marketmaking/quoting.ts` computes a quoting ladder — volatility
widening, inventory skew, position limits — and says of itself, plainly, that it
"signs nothing … whether those prices are ever sent is a separate decision made
somewhere that has the authority to make it." That decision was never made. The
admin market-making page states the consequence: *"It does not place orders, and
nothing in the platform can."*

`passive-cash.ts` was written against that missing execution. It carries a
function, `distributeResult`, that would split a trading result across the
participants who opted in — and nothing calls it, because there is no trading
result to split. The whole programme is gated off at
`PASSIVE_CASH_ENABLED`, with the file naming the reason: *"The market maker has no
execution path … taking money for a book that cannot trade would be taking money
for a service that does not run."*

The platform therefore earns, today, only from what user flow pays: FLT fees on
spot and perp orders, builder codes, and subscriptions. The quoting engine and the
profit-share machinery exist and are inert.

Separately, automated trading was previously built and then **deliberately
removed** (`81f00c4`), and the handoff instructs the next author: *"Do not
reintroduce an automated trading path, and do not couple manual trading to any
agent infrastructure."* That instruction was correct for its time and is exactly
what this ADR overrides — consciously, and with the operator's decision recorded
here rather than assumed.

The operator has decided (2026-09) to build the market maker: an autonomous book
that quotes both sides of a FLT-listed market and earns the spread. This ADR
authorises it and fixes the design so the same mistakes are not re-made.

## Decision

### 1. The maker is FLT's own book, and it is attributed as such

The market maker trades **FLT's capital**, not a participant's. ADR 0006 forbids
trading the pooled venue account with "no participant attributable" — but the
failure that rule guards against is *client money* moved without a client to
attribute it to. The maker is the opposite case: it is FLT trading as principal on
its own behalf. Its positions and P&L belong to **`PLATFORM_EQUITY`**, the ledger
account ADR 0006 P8 already created for FLT's own capital.

For that reason the maker does **not** reuse `PerpOrder`. That model requires a
`userId` and a `walletId` and exists to record what FLT specified on a
participant's behalf and to reconcile it against their fill. The maker has no
participant. It gets its own tables (`market_maker_config`, `maker_order`,
`maker_fill`), for the same reason passive-cash was kept off the trading tables:
the day someone has to answer "which of these is client money", the answer must be
a query, not an argument.

### 2. The maker runs on a dedicated venue account and agent key

ADR 0005 funds and trades a **single** Hyperliquid account for participants, with
their per-participant positions attributed by a `PerpOrder` row. Netting house
quotes into that same account would make "whose position is this" unanswerable at
the venue, and would put a machine's resting orders underneath a person's margin.
The maker therefore runs on a **separate FLT venue account**, authorised with its
**own agent key** (same mechanism as ADR 0005, `readPerpsAgentKey` /
`placeCustodyPerpOrder`), encrypted at rest and never logged. House and client
positions never share an account, so they can never net.

### 3. Quotes are post-only, and requoting is idempotent

The maker **adds liquidity only**: every quote is submitted with `ALO`
(add-liquidity-only, already mapped in `submitPrepared`). A quote that would cross
is rejected by the venue rather than executed — the maker never takes, so it can
never be the flow it is paid to face.

Requoting is cancel-then-place. Because a crash between the two would otherwise
double-place, every quote carries a deterministic client order id (`cloid`), and
the port gains the order-management calls the maker needs (`getOpenOrders`,
`cancelOrders`) that today's `PerpVenue` interface lacks.

### 4. Capital and results move through the ledger, idempotently

House capital is seeded `PLATFORM_EQUITY -> VENUE_MARGIN`; realized maker P&L is
booked `VENUE_MARGIN <-> PLATFORM_EQUITY`. Every movement is a balanced transfer
with a reference, so a retried cycle cannot double-post — the same discipline the
rest of the ledger keeps. Unrealized P&L stays at the venue, as ADR 0006 decided;
the ledger books realized, and reconciliation explains the difference rather than
correcting it.

### 5. Passive cash remains off until separately decided

Wiring the maker does not turn passive cash on. Participant money managed in a
pooled trading strategy is custody **plus**, in most jurisdictions, a collective
investment scheme with its own authorisation regime — the regime `passive-cash.ts`
names and `env.ts` refuses to flip quietly. The maker first runs on house capital
alone. Contributions and `distributeResult` are wired but stay disabled behind
`PASSIVE_CASH_ENABLED`, which no code change in this ADR sets.

### 6. The kill switch is the primary control

An automated system that trades real money needs an off that does not depend on a
deploy. `MM_ENABLED` gates the worker pass; a persisted halt flag and hard caps
(max inventory, max daily loss, max notional) gate each cycle. When any trips, the
maker stops quoting — and cancels its resting orders — rather than trading through
the condition. A maker that cannot be stopped is not a feature; it is a liability
with a spread.

## What this makes FLT, and what it owes

FLT now runs an **automated trading system with a server-held trading key** on a
venue account it funds. This is the **third** deliberate custody exception, after
the omnibus (ADR 0004) and the participant perp agent key (ADR 0005), and the
first where the thing signing is a machine acting on FLT's own behalf. The
obligations are real:

- **A bug is money lost, and a stuck loop is an open market position.** The agent
  key can place and cancel — it cannot withdraw, which bounds the blast radius but
  does not bound the market risk of a book left quoting into a cascade.
- **Key custody remains the highest-value secret in the system.** The maker's
  agent key is encrypted at rest, never logged, and revocable.
- **Reconciliation must distinguish house from client.** The venue-holdings leg
  (ADR 0005) already reports the omnibus venue account; it must not count the
  maker's account, or a house loss could mask a client shortfall — or a house gain
  mask that the ledger owes more than a *client* account holds.
- **Managed participant money is a separate authorisation.** §5.

## Consequences

- **Automation returns, but scoped.** It is one pass, on one venue account, on
  FLT's own capital, behind a kill switch. It is not a general agentic-trading
  subsystem, and manual/perpetual trading is not coupled to it — the coupling that
  had to be reverted once already (`1171eef`).
- **The quoting engine finally has a consumer**, and `distributeResult` finally has
  a caller — but only after a participant result exists to distribute.
- **New surfaces to reconcile and audit:** the maker account, its orders and fills,
  and the `PLATFORM_EQUITY` balance. Each is a place the bookkeeping can silently
  drift, so each is reconciled on the same rule as the rest: alert on divergence,
  never auto-correct.

## Rejected alternatives

- **Keep it model-only (the status quo).** Rejected by the operator. It leaves the
  quoting engine and passive-cash permanently inert and forgoes the only revenue
  the platform can earn without user flow.
- **Operator-driven quoting, no autonomous loop.** Lower risk, but the edge a
  maker earns is the spread on flow that wants immediacy; a human at the screen
  cannot quote continuously, and the economics `estimateMakerEconomics` describes
  assume the book is always there.
- **A synthetic "house" user to reuse `PerpOrder`.** Cheap to write, but it puts
  FLT's own book into the participant table and makes "is this client money?" a
  question about a magic user id. The separate tables cost a model and buy the
  answer.
- **Run the maker on the shared omnibus venue account.** Rejected: nets house and
  client positions and puts a machine's orders under a person's margin — see §2.
