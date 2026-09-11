# Production deployment

What is actually live, as of 2026-09-06. No secrets here — those live only in
`/opt/flt-exchange/.env` on the server and in whichever secrets manager you
choose later.

## Custody is live (ADR 0004)

FLT is a **custodian** as of this revision. Client funds pool in a single
FLT-controlled Privy wallet (the *omnibus*); the double-entry ledger is the
source of truth for participant balances, and FLT signs from the omnibus. This
**reverses ADR 0001** (non-custodial), which is superseded.

- **Ledger-as-truth**: buying power, deposits and withdrawals are ledger
  movements, not chain balances.
- **Reconciliation is mandatory** (`docs/adr/0004-custodial-omnibus.md`): the
  worker compares the omnibus's holdings against total client liability and the
  venue's margin, and alerts on a shortfall. It never auto-adjusts.
- **Perps are custodial too** (ADR 0005/0006) — see the Perpetual futures
  section below.
- The custody path is **a no-op unless `CUSTODY_PROVIDER=privy`** and the
  `OMNIBUS_*` / `PRIVY_*` vars are set on the server. **The deploy does not set
  them** — see "Deploying the custody config".

> The sections below predate custody and still describe a non-custodial
deployment ("FLT never holds collateral, never signs, never submits"). Where
they conflict with the custody model, **the custody model wins**.

## Topology

- **Server**: Hetzner VPS, Ubuntu 22.04, `204.168.254.41`. 2 vCPU / 3.7 GiB RAM
  / 38 GiB disk, plus a 4 GiB swapfile added for headroom during `pnpm build`
  (two Next.js production builds concurrently on 3.7 GiB is tight without it).
- **DNS / edge**: Cloudflare, proxied (orange-clouded), for `ftlexchange.com`.
  - `app.ftlexchange.com` → the consumer app (`:3000`)
  - `admin.ftlexchange.com` → the admin panel (`:3001`)
  - SSL/TLS mode: **Full (strict)**. The origin presents a Cloudflare Origin
    Certificate (`/etc/ssl/cloudflare/ftlexchange-origin.pem` +
    `ftlexchange-origin.key`, both SANs, 15-year validity, issued
    2026-09-06) — this cert is trusted by Cloudflare only, not publicly, which
    is correct for an origin Cloudflare always sits in front of. It is **not**
    a Let's Encrypt cert, so certbot renewal does not apply to it; if it is
    ever regenerated in the Cloudflare dashboard, replace both files on the
    server and reload nginx.
- **Reverse proxy**: nginx, config at `deploy/ftlexchange.com.nginx.conf`
  (installed as `/etc/nginx/sites-available/ftlexchange.conf`, symlinked into
  `sites-enabled`), plus `deploy/cloudflare-realip.conf` (installed as
  `/etc/nginx/conf.d/cloudflare-realip.conf`) so `$remote_addr` — and
  therefore both nginx's `limit_req` zones and the application's own
  rate-limit buckets — resolve to the real visitor IP rather than
  Cloudflare's edge IP. `deploy/proxy_params_flt` is installed as
  `/etc/nginx/proxy_params_flt`.
- **Apps**: `web`, `admin`, and the `worker`, each a systemd unit
  (`deploy/flt-{web,admin,worker}.service`) running as the unprivileged `flt`
  system user out of `/opt/flt-exchange`, reading `/opt/flt-exchange/.env`.
- **Database**: PostgreSQL 14 (Ubuntu's default `apt` package), local to the
  server. Role and database are both named `flt_exchange`.
- **Firewall**: `ufw` — only 22, 80, 443 open. `fail2ban` running against SSH.
- **Deploy access**: a repo-scoped, read-only GitHub Deploy Key lives at
  `/root/.ssh/flt_deploy_key` (and a copy at `/home/flt/.ssh/flt_deploy_key`
  so the `flt` user can pull without root). It can only read this repository —
  rotate it from the repo's Settings → Deploy keys if it is ever suspected
  compromised.

## What's real vs. what's a placeholder

Configured with live production credentials, provided directly by you:

- `DEX_ROUTER=zeroex` with a real 0x API key
- `BASE_RPC_URL` on a keyed Alchemy endpoint (with the public Base RPC as
  `BASE_RPC_FALLBACK_URL`)
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` — a real Reown project ID
- `MARKET_DATA_PROVIDER=coingecko`, `PRICE_HISTORY_PROVIDER=geckoterminal` —
  both on the free keyless tier, so subject to that tier's rate limits

**Perpetual futures are live on this deployment** (`PERPS_ENABLED=true`,
`PERP_VENUE=hyperliquid`). The signing step is not built, so a user can reach
the order ticket but cannot submit an order. Read the section below before
treating the feature as finished.

**Not yet configured — a real gap, not a cosmetic one:**

- **Email**: `MAIL_PROVIDER=console`. Verification and password-reset emails
  are logged, not delivered. `packages/config/src/env.ts` treats this as a
  loud runtime warning rather than a startup refusal — deliberately, since
  unlike the other production guards in that function it doesn't fabricate
  data, it just fails to send mail — but it means **no one can complete
  signup or reset a password against this deployment today.** Set
  `MAIL_PROVIDER=resend` and `RESEND_API_KEY` to close this.
- ~~`FLT_FEE_RECIPIENT_ADDRESS` is blank~~ — **resolved.** Fees are live: 25 bps
  on spot, paid to `0xb3dc877Fb48022D36412314B68139e8939affDBa`, and 10 bps
  configured for Hyperliquid builder codes. See "Fees" below.
- **Admin panel network restriction**: the `allow`/`deny` block in
  `ftlexchange.com.nginx.conf` for `admin.ftlexchange.com` is commented out.
  The panel is reachable from the open internet behind only its own
  login + MFA. This is called out in the original plan as "the single
  highest-value control on the whole deployment" and should be turned on —
  either an IP allow-list or Cloudflare Access — before real users exist.

## Deploying the custody config

`deploy/update.sh` pulls, installs, builds and migrates — it does **not** touch
`/opt/flt-exchange/.env`. The custody variables live there and must be set on the
server **once**, or the custody path silently no-ops (`CUSTODY_PROVIDER`
defaults to `disabled`). Values are in `GO-LIVE-ENV.txt`. At minimum:

    CUSTODY_PROVIDER=privy
    OMNIBUS_EVM_ADDRESS=0x...
    OMNIBUS_EVM_WALLET_ID=...
    PRIVY_APP_ID=...  PRIVY_APP_SECRET=...
    AUTO_WALLET_PROVISIONING_ENABLED=true
    DEX_ROUTER=zeroex  ZEROEX_API_KEY=...
    FLT_FEE_RECIPIENT_ADDRESS=<the omnibus>
    PERPS_ENABLED=true  PERP_VENUE=hyperliquid

Then restart `flt-web flt-admin flt-worker`. Copy-paste commands are in
`deploy/CUSTODY-DEPLOY.txt`.

## Redeploying

```bash
ssh root@204.168.254.41
cd /opt/flt-exchange
sudo -u flt git pull origin main
sudo -u flt pnpm install --frozen-lockfile
sudo -u flt pnpm --filter @flt/db exec prisma generate
sudo -u flt pnpm build
sudo -u flt pnpm --filter @flt/db exec prisma migrate deploy   # only if schema changed
systemctl restart flt-web flt-admin flt-worker
```

No CI/CD is wired up yet — this is a manual pull-and-rebuild, which is fine at
this stage but is the next real gap once deploys become routine.


## Perpetual futures — now custodial

Leveraged perpetuals are routed to the external venue (Hyperliquid). Under the
custody model (ADR 0005/0006), FLT funds the venue from the omnibus, holds a
**server-held agent key** authorised by the omnibus, and places orders **for the
omnibus** on the participant's behalf. The participant's margin is reserved on
the ledger before broadcast and settled on the fill; the participant connects no
wallet and signs nothing.

> The non-custodial description that used to head this section — "margin is
> posted by the user's own wallet; FLT never holds collateral, never signs, and
> never submits" — is **no longer true**. It is kept in spirit below for history.

### Off by default, on here

The code defaults to `PERPS_ENABLED=false`, and `PERP_VENUE=mock` is refused in
production for the same reason `DEX_ROUTER=mock` is: a simulated venue quotes
positions that do not exist and liquidation prices for collateral nobody posted.

This deployment has it enabled against the real venue:

    PERPS_ENABLED=true
    PERP_VENUE=hyperliquid
    PERP_MAX_LEVERAGE=10
    PERP_BUILDER_FEE_BPS=0

Three markets are offered — BTC, ETH and SOL — each capped at 10x against venue
maximums of 40x, 25x and 20x. They were enabled by direct SQL during initial
provisioning because there was no operator session yet; **every later change
should go through the admin panel** so it lands in the admin action log.

The registry is populated by `pnpm sync:perp-markets BTC ETH SOL`, which reads
asset ids from the live venue rather than trusting hardcoded ones, creates rows
disabled, and never re-enables a market an operator has taken off sale.

### Limits FLT sets independently of the venue

- `PERP_MAX_LEVERAGE` (default 10) is a global ceiling. No order is accepted
  above it whatever an individual market is configured for. Hyperliquid lists
  markets up to 40x; offering that because the venue permits it is a decision,
  and this is where it gets made.
- Each market carries its own cap in the registry, editable in the admin panel
  and clamped to the venue's maximum.
- `PERP_BUILDER_FEE_BPS` is FLT's builder code, capped at 10 bps by the venue.
  It requires `HYPERLIQUID_BUILDER_ADDRESS`, and the adapter refuses a fee above
  the venue's cap rather than being refused by the venue.

### What is verified and what is not

**Verified against live mainnet:** the read path. Markets, prices, funding,
open interest, account state and agent-authorisation status all parse from the
live `/info` API — 233 markets, 177 of them tradeable at time of writing — and
the adapter's refusal guards (fee above cap, size below minimum, unknown or
delisted market) all fire.

**Not verified:** the write path. No order has been signed or submitted against
the real venue, because doing so needs USDC bridged to Hyperliquid and a real
position opened. **The signing step is not wired up in the interface at all** —
the review screen prepares and records an order and then says plainly that it
cannot submit it. Nothing can currently reach the venue.

This is the state a user meets today: they can browse markets with live prices,
size a position, see its margin and estimated liquidation price, and then be
told the order cannot be sent. That is deliberate and honest, but it is not a
finished feature.

Completing it needs the venue's own client library in the browser: the agent key
is generated there, never transmitted, and signs orders locally. See the note at
the top of `packages/providers/src/perps/hyperliquid.ts` for why the encoding is
deliberately not reimplemented on the server.

### Collateral leaves Base

Hyperliquid settles on its own L1. This is the one place the product's core
promise — that assets stay in the user's wallet — does not hold, and the
interface says so on both the market list and the order screen. Bridging is not
built; a user has to move funds themselves.

### Outstanding before real users

- **No jurisdiction restriction.** Perpetuals are derivatives, and offering
  leveraged derivatives to retail is a licensed activity in most jurisdictions
  that matter — the FCA banned it for UK retail consumers outright, the EU
  treats it under MiFID II, and in the US it is CFTC territory. There is
  currently no geo-blocking and no derivatives-eligibility gate on the KYC
  profile. This was a deliberate deferral, not an oversight, and it is the
  single largest outstanding item on this feature.
- **The signing path is unbuilt**, as above.
- **No funding-cost accounting.** Funding is displayed per interval and
  annualised, but accrued funding is read from the venue rather than
  independently tracked.
- **Liquidations are recorded as suspected, not observed.** The venue does not
  report why a position closed, so the worker logs a position that vanished
  while near its liquidation price as suspected and says so in the audit entry.


## Fees

Live since 2026-09-06.

| | Rate | Where it is set | Status |
|---|---|---|---|
| Spot swap | 25 bps (0.25%) | The `Default` row in `fee_configs` | **Collecting** |
| Perp builder code | 10 bps | `PERP_BUILDER_FEE_BPS` (env) | Configured, not yet collecting |

Both pay to `0xb3dc877Fb48022D36412314B68139e8939affDBa` on Base.

Verified against a live 0x quote: 100 USDC → WETH returned a fee of 0.00010065
WETH, an implied 25.00 bps, about $0.25 on a $100 trade.

### Two things to know about how this money arrives

**Spot fees arrive as the token being bought**, not as a stablecoin. `quotes.ts`
sets `feeTokenAddress` to the buy token, which is how 0x's affiliate mechanism
works. The wallet will accumulate whatever users buy — cbBTC, WETH, AERO, USDC —
so expect dust across several ERC-20s and plan a periodic consolidation.

**Perp fees are not collecting yet.** Hyperliquid requires the *user* to approve
a builder before it will accept orders carrying that builder code, and that
approval is signed in the browser as part of the order-signing path, which is not
built. The 10 bps is attached to prepared orders and validated against the
venue's cap, so it is correct and harmless — it simply cannot be charged until
signing ships.

### Changing the rate

`fee_configs` resolves most-specific-first: token (+4), chain (+2), account tier
(+1), with `priority` breaking ties. So a cheaper institutional rate is a new row
with `accountType = 'INSTITUTION'`, and it outranks the default automatically.

Rules are created, edited and disabled from the admin panel's fee page. Every
change writes an `admin_actions` row with before/after and a required reason.
Rules are never deleted, only disabled, so a historical quote can always name
the rule that priced it.

A customer's pricing tier is changed from their user page. A tier only changes
what they pay where a fee rule names that tier; without such a rule the account
keeps paying the default.

### Listing a token

    pnpm add:token 0xContractAddress "Display name"

Reads `symbol()` and `decimals()` from the chain rather than taking them as
arguments, and writes the row **disabled** and `UNVERIFIED`. A disabled token
appears in the Markets table marked as such but is not tradeable and is excluded
from quoting and from the trade selector.

Enabling it, and raising its verification tier, are separate deliberate acts.
Keep them separate: the tier communicates that FLT reviewed the contract, so if
listing is ever sold, a paid listing must never raise a tier or the warning on
unreviewed tokens stops meaning anything.
