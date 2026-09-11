# Perpetuals → custody: design

Blueprint for step 7 of the custody plan. Implements ADR 0005 (Accepted):
**real Hyperliquid perps, server-held omnibus-backed agent key.**

Nothing here is built yet — it describes the shape so it can be built in
reviewable slices, the same way spot was.

## The one-sentence model

Perp **collateral** and **positions** live at the venue (Hyperliquid); the
**omnibus** owns the venue account and, via a server-held agent key, places the
orders each participant initiates; the **ledger** records the participant's
margin and the venue's collateral as movements out of `CLIENT_OMNIBUS`.

## Why it is not just "spot with a different venue"

Spot settles on-chain to the omnibus, so the ledger and the chain agree by
construction. Perps settle **off our chain** at a venue that holds the margin
itself. That adds three things spot did not have:

1. **A second signer** — the agent key (server-held).
2. **A second place funds live** — venue margin, not the omnibus EVM wallet.
3. **A second reconciliation surface** — venue positions/margin vs the ledger.

## Components

### 1. Agent-key lifecycle (new — providers)

- **Mint**: generate an agent keypair (the "API wallet" Hyperliquid expects).
- **Authorise**: the **omnibus** signs Hyperliquid's EIP-712 `approveAgent`
  action via Privy (`managedAccountFor` → `createViemAccount` → `signTypedData`),
  then submit it to the venue. One-time per key; re-authorisation on rotation.
- **Store**: the agent private key encrypted at rest with AES-256-GCM (the same
  primitives as MFA secrets — `packages/core/src/services/crypto`). **Never**
  logged. This is the highest-value secret in the system.
- **Use**: the agent key signs venue orders (place/cancel only).
- **Revoke**: call the venue to revoke, wipe the stored key. A rotation path is
  required, not optional.

New port `packages/core/src/ports/perps`-adjacent (or a small `PerpsCustody`
port) so the venue mechanics stay in `providers` and the policy in `core`.

### 2. Venue funding (ledger)

- Funding the venue is a **ledger event**: `CLIENT_OMNIBUS` (the omnibus that
  bridges USDC to the venue) balances against a per-venue **venue account**.
- A participant's margin is a `USER_LOCKED` balance reserved against their open
  positions. Unfunded leverage is refused.
- Withdrawing from the venue returns value `venue account -> CLIENT_OMNIBUS`.

### 3. Order build + submission

- `HyperliquidPerpVenue.prepareOrder` is already built for an account address;
  under custody that address is the **FLT venue account**, not the participant's
  wallet (`packages/core/src/services/perps.ts` `prepareOpen` takes `wallet`).
- Submission moves to the **server**: the agent key signs the prepared action and
  posts it (the mechanics exist in `packages/providers/src/perps/submit.ts`).
- The participant does **not** sign and does **not** connect a wallet — matching
  the custodial product. `perp-submit.tsx` loses its wagmi path.

### 4. Ledger settlement on fill

`PerpOrder` already records every economic field before submission. On the
venue's fill report (the worker's perp sync — `apps/worker/src/perps.ts`), post:
- opening: margin `CLIENT_OMNIBUS -> USER_LOCKED`; fee -> `FEE_REVENUE`.
- closing: realised PnL moves between the participant's available balance and
  the venue account; margin released `USER_LOCKED -> USER_AVAILABLE`.
Idempotent on the venue order id (a `TRADE_SETTLEMENT`-style reference).

### 5. Venue-side reconciliation (new)

A second leg alongside ADR 0004's on-chain one: read the venue account's margin +
open positions and compare to the ledger's perp liabilities **per participant**.
Alert on divergence; never auto-adjust. Without it, perp margin is an unbacked
number — the same failure the on-chain reconciliation exists to prevent.

## Data model (new)

- **`PerpsAgentKey`** (or extend `PlatformSetting`): `venue`, `keyCiphertext`,
  `keyAddress`, `authorizedAt`, `revokedAt`, `version`. One active key per venue.
- **Venue account mapping**: which FLT venue account each participant's positions
  belong to (single pooled account under custody, with per-participant
  attribution on `PerpOrder` — which already carries `userId`).

## Config

- `PERPS_ENABLED=true`, `PERP_VENUE=hyperliquid` (done).
- New: the venue agent key lives in the DB (encrypted), not env — but a
  boot-time guard should refuse `PERPS_ENABLED` on a real venue with no active
  key once the build lands.

## Risks (from ADR 0005)

- The agent key can trade the pooled venue account. Encrypt at rest, never log,
  revocable; treat a leak as incident-severity.
- Venue margin is a second pool of client funds the ledger and reconciliation
  must both account for.
- Hyperliquid collateral is USDC on Hyperliquid/Arbitrum — off-Base — so spot and
  perps deliberately use different funding rails.

## Build slices (suggested order)

1. Agent-key lifecycle (mint + Privy-authorise + encrypt + store) + a read check.
2. Server-side order place for one market, unfunded (venue rejects) — proves
   signing.
3. Venue funding ledger movement + margin lock.
4. Fill-driven ledger settlement.
5. Venue-side reconciliation.
6. Front-end: drop the wallet path from `perp-submit.tsx`; show margin/free
   margin from the ledger.
