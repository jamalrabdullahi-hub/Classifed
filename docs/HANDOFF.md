# Handoff

Context for an agent picking up work on FLT-Exchange. Written for delegation:
the operator supervises rather than writes, so this front-loads the things that
are expensive to rediscover and the mistakes that have actually been made here.

Read `docs/adr/0001-non-custodial-architecture.md` before touching anything that
signs.

---

## 1. What this is

A crypto exchange for the Somali market. Next.js 15 App Router, pnpm workspaces
+ Turborepo, Prisma/Postgres.

```
apps/web      participant-facing app (Somali-named routes: /iibso, /boorso, …)
apps/admin    operator panel
apps/worker   background jobs
packages/core     domain, services, ports. No provider SDKs.
packages/db       Prisma schema + hand-written migrations
packages/providers  adapters: DEX routers, Privy, Hyperliquid, market data
packages/config   env parsing and validation
packages/ui       design system
```

`core` defines ports; `providers` implements them. A provider SDK imported into
`core` is a layering break — `providers` exists because wallet provisioning and
perp execution need both the venue SDK and `@flt/db`.

### Money model, in one paragraph

FLT is **not** a crypto custodian. Participants' funds sit in FLT-provisioned
wallets whose keys are held by **Privy** (MPC), or in wallets they linked
themselves. On the fiat leg FLT *is* a money transmitter: it takes cash, buys
crypto, and delivers it to the participant's Privy wallet. The double-entry
ledger records only that in-between liability and **nets to zero** on delivery.
The balance a participant sees is their real on-chain balance, not a number FLT
invented. Do not add a code path that makes the ledger a store of value.

---

## 2. Hard constraints

These are not style preferences. Each one has already cost a production
incident or a wasted deploy cycle.

### Verification: there is no local database

No Postgres runs on the dev machine. The full verification loop is:

```bash
pnpm typecheck
pnpm test
pnpm --filter @flt/web build && pnpm --filter @flt/admin build
pnpm --filter @flt/db exec prisma validate
```

**Prisma is mocked in tests.** A unit test cannot catch a database constraint
violation — this is exactly how a ledger CHECK constraint that made deposits
impossible to record shipped, with a passing test whose fixture contained the
precise row Postgres would have refused. When you touch a constraint, walk a
concrete example through it by hand and say so in the commit message. There is
still no integration harness; adding one is open work.

### Migrations are hand-written

`packages/db/prisma/migrations/<timestamp>_<name>/migration.sql`. Never
`prisma migrate dev` (no local DB to diff against). Known Postgres traps:

- `ALTER TYPE … ADD VALUE` **cannot be added and used in the same
  transaction** — split into two migrations. See `20260910105000_deposit_sent_enum`.
- `chains.chainId` and every column referencing it are **INTEGER** (signed
  32-bit). A value above 2,147,483,647 fails at insert with SQLSTATE 22003.
  This broke every deploy once; see `SOLANA_CHAIN_ID` in
  `packages/providers/src/wallet-provisioning/provision.ts`.
- A failed migration blocks all later ones until
  `prisma migrate resolve --rolled-back <name>`.

### The ledger sign convention

`packages/core/src/services/ledger.ts` is the most correctness-critical file in
the repo. Debits positive, credits negative.

| Account kind | Stored balance |
|---|---|
| `CLIENT_OMNIBUS`, `FIAT_GATEWAY` (assets) | `>= 0` |
| `USER_AVAILABLE`, `USER_LOCKED`, `FEE_REVENUE` (liabilities) | `<= 0` |

`naturalBalance()` negates for reading. Every transfer must sum to zero — a
deferred constraint trigger enforces it in the database, not just in code.
`(kind, reference)` is unique, which is what makes posting idempotent.

### Internationalisation

`next-intl`. **Every string needs an entry in both `apps/web/messages/en.json`
and `so.json`.** A missing key is a runtime failure, not a fallback. Somali is a
real product language here, not a placeholder — do not machine-translate
carelessly, and watch for Cyrillic lookalikes (a `а` in `u dirаysaa` slipped
through once).

### `.npmrc` sets `shamefully-hoist=false` deliberately

A package must declare what it imports. A script that imports `@privy-io/node`
has to live inside the package that depends on it — putting it in a repo-root
`/scripts` means it cannot resolve. Also make sure any new `scripts/` directory
is in that package's `tsconfig.json` `include`, or it is never typechecked and
you will ship a call to a method that does not exist.

### Windows authoring

Commits are authored on Windows, which has no executable bit, so **git records
new shell scripts as `0644` no matter what `chmod` says locally.** After adding
one: `git update-index --chmod=+x path/to/script.sh`. Prefer invoking through
`bash script.sh` so it does not matter.

---

## 3. Deployment

**Deploys are automatic.** A systemd timer on the server checks `origin/main`
every two minutes and runs `deploy/update.sh` when the hash moves. Pushing to
`main` puts code in production within about two minutes. Treat every push that
way.

- `deploy/update.sh` — pull, install, generate, build, **migrate, then**
  restart. A failed migration aborts before any restart, so the site stays up
  on the old build.
- `deploy/auto-deploy.sh` + `flt-autodeploy.{service,timer}` — the poller.
- Watch: `journalctl -u flt-autodeploy -f`
- Stop: `systemctl disable --now flt-autodeploy.timer`

The agent has **no SSH access**. Anything requiring the server is handed to the
operator as a command to run.

### Secrets

- Never generate a secret locally that belongs on the server. `openssl rand`
  runs *on the server*.
- Never print a secret into chat, and never ask the operator to paste one.
  `PRIVY_APP_SECRET`, `ENCRYPTION_KEY` and friends go straight into the server
  `.env`.
- `ENCRYPTION_KEY` is env-only, never a `PlatformSetting`.

---

## 4. Current state

### Working

- Privy wallet provisioning, with delegated consent to sign
  (`packages/providers/src/wallet-provisioning/`)
- **Spot trading from an FLT wallet, end to end** — the trade screen picks the
  managed path per wallet and posts to `/api/trades/execute`;
  `/api/approvals/execute` grants the allowance
- Fiat deposit rail: four operator stages, ending in an on-chain check that the
  USDC actually landed before trading is enabled
  (`packages/core/src/services/fiat-deposits.ts`, admin at `/payments`)
- EVC USSD checkout, remittance (Xawilaad), custody ledger

### Known gaps

1. **Perps cannot use an FLT wallet.** See section 5 — the next task.
2. **Withdrawals are not built.** Neither crypto-out nor fiat/EVC-out. The
   participant's six-step loop is open at step 6.
3. **No integration test harness.** Flagged repeatedly; this is how the ledger
   bug survived.
4. **`MAIL_PROVIDER=console`** — no email actually delivers in production.
5. **Referral banner economics** (50%/100% off) do not match
   `REFERRAL_SHARE_BPS=2000`. The operator said they would handle it.
6. Repo-root `/scripts` is still not covered by any tsconfig.
7. **Wallet backfill**: provisioning runs at registration and on the explicit
   button. Accounts predating the feature have no FLT wallet until somebody
   presses it.

---

## 5. Next task: Hyperliquid perps from an FLT wallet

**Do not start this without a decision from the operator.** It is not a wiring
job; it forces an architectural choice, and choosing wrong is the kind of thing
ADR 0001 exists to prevent.

### The mechanism

Hyperliquid signs L1 actions over chain id 1337, which wallets refuse. The
venue's answer is an **agent key**: a second key, authorised once by the owner
wallet via an EIP-712 signature, that can place and cancel orders but
**cannot withdraw or transfer** — enforced by the venue.

Today that key is generated **in the browser** and never transmitted
(`apps/web/src/lib/hyperliquid-agent.ts`): sessionStorage, keyed by owner
address, dies with the tab. Read the header comment there; the three rules in
it are load-bearing.

A Privy wallet has no browser key, so there is no owner to sign the agent
authorisation and nowhere natural for the agent key to live.

### The decision

Privy can sign EIP-712 typed data server-side through `managedAccountFor()`
(`packages/providers/src/wallet-provisioning/signer.ts`), so **authorising** an
agent for a managed wallet is straightforward. The open question is where the
agent key then lives:

- **Server-side** — FLT holds a key that can trade a participant's account
  (not drain it). This is a second deliberate exception to non-custodial
  design. It needs an ADR, encryption at rest, and an explicit revocation path.
- **Browser-side, agent-only** — the agent key stays in sessionStorage as it
  does now, and only the *authorisation* is signed by Privy. Keeps the current
  guarantee; costs a re-authorisation per session.

The operator has previously removed an entire agentic-trading subsystem rather
than accept server-held trading keys, and has separately asked for one-click
execution. Those pull in opposite directions. **Ask; do not infer.**

### Prior context worth knowing

Agentic/AI trading was **deliberately removed** (`81f00c4`). Do not reintroduce
an automated trading path, and do not couple manual trading to any agent
infrastructure — that coupling was itself a bug that had to be reverted
(`1171eef`).

---

## 6. Working style expected here

- **Comments explain why, not what.** The codebase's existing comments are
  long-form and argue for the decision, often naming the failure the code
  prevents. Match that; do not strip it back to one-liners.
- **Commit messages state the failure and the reasoning.** Look at
  `git log` before writing one.
- Prefer fixing a problem on both sides when either alone leaves a trap set for
  the next person.
- When something cannot be verified, say so plainly rather than implying it was
  tested.
- Push back on a request that takes on risk the operator may not have priced —
  state the concern once, then build what was asked.
