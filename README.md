# FLTCrypto

A USD-denominated crypto brokerage MVP for the Somali market. Customers deposit
USD through a mobile-money provider, buy and sell BTC / ETH / SOL / USDT / USDC
against the brokerage, and withdraw crypto to their own wallets.

**This is a brokerage, not an exchange.** There is no order book, no matching
engine, no leverage, no staking. The customer trades against us; we source
liquidity from a venue behind an interface.

The visible application is deliberately plain. The rigour is in the ledger,
the payment reconciliation, the order execution and the withdrawal handling.

---

## Running it locally

Requires Node 20+ and Docker. **Docker is for local development only** — it runs
a disposable Postgres. The server installs PostgreSQL natively; see
[docs/deployment.md](docs/deployment.md).

```bash
npm install
docker compose up -d
cp .env.example .env        # then set APP_SECRET (see below)
npm run db:deploy
npm run db:seed
npm run dev
```

Generate `APP_SECRET`:

```bash
openssl rand -base64 48
```

Dev logins created by the seed: `customer@example.com` and `admin@example.com`,
password `Password123!`.

**Every provider is mocked by default. No real money moves.** The app refuses to
start with `NODE_ENV=production` while any provider is still `mock`
(`src/server/env.ts`).

### Verifying it works

```bash
npm test                       # 131 unit + integration tests
npx tsx scripts/walkthrough.ts # 40 end-to-end checks against a running dev server
npm run reconcile              # proves the books balance and are solvent
```

`walkthrough.ts` drives the whole customer journey through the HTTP API —
register, KYC, deposit, quote, buy, sell, withdraw, history — and also exercises
the abuse cases: a replayed webhook, a tampered webhook, a duplicated order, a
wrong-chain address, a bad confirmation code, and a rate-limit burst.

---

## Architecture

```
src/
├─ domain/          Pure. Money, ids, errors, state machines. No I/O, no framework.
├─ providers/       PaymentProvider, LiquidityProvider, BlockchainProvider, KYCProvider
│  └─ registry.ts   The ONLY module that names a concrete vendor.
├─ services/        Orchestration. The only writers of ledger entries.
├─ server/          Infrastructure: db, env, crypto, sessions, route plumbing.
└─ app/             Next.js routes and UI. Thin.
```

Business logic never imports from `next/*`, and never names a vendor. Swapping
WAAFI for another payment provider is a new adapter directory plus one line in
`registry.ts`.

### The operator panel

`/admin` is guarded by a layout that redirects non-administrators, and every
`/api/admin/*` route re-checks independently — a page guard protects rendering,
not data. Overview, users, KYC review, manual approvals, deposits, withdrawals,
orders with their execution attempts, treasury, a ledger explorer, reconciliation
and the audit trail.

An operator can decide three things: a KYC verdict, a manual approval, and a
user's account status. **There is no "adjust balance" action and there must never
be one** — corrections are reversing journal entries, not edits. Approvals
enforce segregation of duties: an administrator cannot approve a request arising
from their own account. Every decision writes an audit row naming the actor.

### The ledger

Double-entry, append-only, and the source of truth for every balance.

- Amounts are `NUMERIC(38,18)` in Postgres and `decimal.js` in code. **No floats.**
- Every transaction balances to zero **per asset**. Enforced three ways: in
  `services/ledger.ts`, by a deferred Postgres constraint trigger, and by tests.
- `UPDATE` and `DELETE` on `ledger_entries` / `ledger_transactions` raise a
  database exception. Corrections are reversing entries; history is never rewritten.
- `balance_projections` is a cache maintained in the same transaction as the
  entries. `npm run reconcile` recomputes from the entries and reports drift;
  `npm run reconcile -- --rebuild` repairs it.

Chart of accounts (`services/accounts.ts`), sign convention DEBIT-positive:

| Code | Kind | Meaning |
|---|---|---|
| `USER_FIAT` / `USER_CRYPTO` | LIABILITY | what we owe a customer |
| `WITHDRAWAL_HOLD` / `ORDER_HOLD` | LIABILITY | earmarked, not spendable |
| `PAYMENT_CLEARING` | ASSET | USD in flight at the payment provider |
| `BANK_USD` | ASSET | settled USD |
| `VENUE_CUSTODY` | ASSET | assets held at the liquidity venue |
| `FEE_REVENUE` | REVENUE | brokerage fees |
| `NETWORK_FEE_EXPENSE` / `PROVIDER_FEE_EXPENSE` | EXPENSE | pass-through costs |
| `TRADING_PL` | EQUITY | spread and slippage |
| `ROUNDING` | EQUITY | sub-minor-unit residuals |
| `ADJUSTMENTS` | EQUITY | manual corrections |

Every business event maps to one journal template in `services/journal.ts`.
Services never hand-assemble legs.

### How money is protected

- **Holds.** Funds move into a hold account before any provider call. Two
  concurrent withdrawals of the same coins cannot both succeed — the second sees
  the reduced balance under `SERIALIZABLE` isolation and is rejected.
- **A webhook never credits anyone.** It is a hint. `verifyAndCreditDeposit`
  re-confirms with the provider out-of-band before posting to the ledger, so a
  forged or replayed webhook cannot mint money.
- **Idempotency everywhere.** Ledger postings are keyed on the business event, so
  however many webhooks, polls or retries arrive, a customer is credited once.
  Mutating API routes require an `Idempotency-Key` header.
- **Timeouts are `UNKNOWN`, not failure.** `provider-log.ts` records every
  outbound call before making it; a call that times out may well have succeeded
  at the provider, and the reconciler surfaces it for resolution.
- **Nothing is stranded.** Every failure path releases its hold. A rejected order
  refunds in full; a failed withdrawal returns the coins.

### Server-side pricing

A quote is priced entirely server-side from a live venue price, is single-use,
and expires (default 30s). The client sends a `quoteId` and nothing else — no
amount, rate or fee crosses the boundary inward. `consumeQuote` claims it with a
conditional update, so two concurrent orders cannot share one quote.

If the venue price moves further than `EXECUTION_SLIPPAGE_TOLERANCE_BPS` between
quoting and filling, the order is rejected and refunded rather than executed at
a worse price.

### Security

Session cookies (httpOnly, sameSite, DB-backed, revocable) · scrypt password
hashing · AES-256-GCM field encryption for KYC document numbers · HKDF-derived
keys per purpose · webhook signature verification over the raw body · replay
protection via a unique `(provider, externalEventId)` index · token-bucket rate
limiting · audit logging with redaction · withdrawal confirmation codes ·
server-side validation of every amount.

Authorization is scoped by the session user at the service boundary. No route
takes a user id from a request body or query string.

---

## Blocked on external dependencies

These are **not implemented**, deliberately. No endpoint, credential name, SDK
method or webhook shape has been guessed at. Each ships as an interface plus a
deterministic mock, with a README naming exactly what is required:

| Provider | Status | What is needed |
|---|---|---|
| **WAAFI Pay** | Adapter throws `ProviderNotConfiguredError` | Merchant API docs: base URLs, auth scheme and real credential field names, payment-request and status-query schemas, disbursement API, webhook payload shape, **signature algorithm and header**, and a stable per-event id for replay protection. Sandbox credentials. See `src/providers/payment/waafi/README.md`. |
| **Liquidity venue** | Mock only | Venue not selected. Needs API docs, sandbox keys, and answers on RFQ vs market execution, fiat-denominated orders, partial-fill behaviour, and client-supplied idempotency keys. See `src/providers/liquidity/README.md`. |
| **Custody / withdrawals** | Mock only | Same venue — withdrawal API, whitelisting, per-asset network and fee behaviour. |
| **KYC vendor** | Mock only (auto-approves) | Vendor not selected. The deciding question is **which documents it accepts for Somali customers**. See `src/providers/kyc/README.md`. |
| **Notifier** | Not built | Withdrawal confirmation codes are returned in the API response in development. **This is not a second factor.** Production needs an out-of-band SMS/email channel before launch. |
| **Compliance** | Business input | Somali licensing, sanctions screening, retention periods, and the real tier limits. The mechanism is built and enforced (`services/limits.ts`); the numbers are placeholders. |

The `.env.example` variable names for these providers are **assumptions** and
must be reconciled against the real documentation.

---

## Adding an asset

Insert a row in `assets`. Nothing in `src/` enumerates symbols. The row carries
`decimals`, `quoteScale`, `network`, `brokerageFeeBps`, trade limits and
withdrawal minimum. The liquidity and blockchain providers must support it.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | Full suite |
| `npm run db:deploy` / `db:migrate` / `db:seed` | Database |
| `npm run reconcile` | Balance, solvency and stuck-record report; exits non-zero when unhealthy |
| `npm run reconcile -- --rebuild` | Rebuild projections from ledger entries |
| `npx tsx scripts/walkthrough.ts` | End-to-end API walkthrough |
| `bash scripts/server-setup.sh` | One-time server bootstrap (Ubuntu, no Docker) |
| `bash scripts/deploy.sh` | Pull, migrate, build, restart, health-check |

## Deploying

Ubuntu, native PostgreSQL, systemd. Full runbook in
[docs/deployment.md](docs/deployment.md).

```bash
git clone git@github.com:jamalrabdullahi-hub/Classifed.git /opt/fltcrypto
cd /opt/fltcrypto && bash scripts/server-setup.sh
```

Then, after any push to `main`:

```bash
ssh root@<server> 'bash /opt/fltcrypto/scripts/deploy.sh'
```

The app refuses to boot with `NODE_ENV=production` while providers are mocked,
so a deployed instance is a staging environment until real providers are wired
in. It must not hold customer data or real funds in that state.

## Known gaps for production

- Reconciliation and withdrawal polling run on demand; they need a scheduler.
- Rate limiting is Postgres-backed. Fine for this scale; Redis behind the same
  interface if it is not.
- `x-forwarded-for` is trusted for IP-keyed rate limits — the deployment must
  put a proxy in front that overwrites it, or those limits can be evaded.
- Reversals and adjustments exist as services with audit logging, but are not
  exposed in the admin panel and must be invoked from a script. This is
  deliberate: an operator must not be able to move money from a web form.
- No backups. See [docs/deployment.md](docs/deployment.md).
