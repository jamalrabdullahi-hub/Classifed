# FLT Exchange

A **non-custodial** DEX trading platform. FLT provides the interface, accounts,
compliance and routing; the user's own wallet holds the funds and signs every
transaction.

> FLT Exchange is not a centralized exchange. It does not custody user funds and
> does not operate an order book. It never requests, stores, transmits or
> exposes seed phrases, private keys or wallet passwords.

## Architecture

```
apps/
  web/       Next.js consumer application        :3000
  admin/     Next.js administrative application  :3001   (separate deployable)
  worker/    Transaction monitor, quote reaper, market cache
packages/
  db/        Prisma schema, migrations, seed
  core/      Domain model, services, chain registry
  providers/ DEXRouter / MarketData / KYC / Mail adapters
  ui/        Design system shared by both apps
  config/    Environment schema and shared TypeScript config
```

The consumer app and the admin app are separate Next.js applications with
separate sessions, separate cookies and separate deployments, so the admin
surface can be firewalled independently.

### The trade path

```
user picks a pair
  → FLT requests an indicative price
  → FLT requests a firm quote and persists the exact calldata
  → user reviews output, minimum received, impact, fees, route and contract
  → the user's WALLET signs
  → the wallet broadcasts to the chain
  → FLT monitors and records settlement
  → portfolio and activity update
```

FLT never receives funds and never executes against pooled customer assets.

## Requirements

- Node.js >= 20.11
- pnpm 12
- Docker (local Postgres only)

## Getting started

```bash
pnpm install
cp .env.example .env      # then fill in the secrets
pnpm db:up                # Postgres on :5433
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The consumer app runs on http://localhost:3000 and the admin app on
http://localhost:3001.

`DEX_ROUTER=mock` is the default, so the full interface works without any API
key. Set `DEX_ROUTER=zeroex` and supply `ZEROEX_API_KEY` to quote real
liquidity.

## External services

| Service | Needed for | Cost |
|---|---|---|
| [0x API key](https://dashboard.0x.org/create-account) | Live quotes | Free tier |
| [Reown projectId](https://cloud.reown.com) | WalletConnect wallets | Free |
| Base RPC | Chain reads, monitoring | Public endpoint works for dev |
| Funded Base wallet | Proving a real swap end to end | Real funds |

There is no testnet path for real quotes: 0x v2 aggregation has effectively no
testnet liquidity. Use `DEX_ROUTER=mock` for development and a small amount of
real value on Base to verify settlement.

## Commands

| Command | Description |
|---|---|
| `pnpm dev` | Run every app in development |
| `pnpm build` | Build all packages and apps |
| `pnpm test` | Unit and integration tests |
| `pnpm test:e2e` | Playwright end-to-end tests |
| `pnpm typecheck` | Type-check the workspace |
| `pnpm db:migrate` | Apply migrations in development |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm worker` | Run the transaction monitor |

## Scope

Phase 1 is: accounts, KYC onboarding, wallet connection, DEX quoting and
execution, monitoring, portfolio, market registry, and administration.

Phase 2 — risk engine, insurance, margin, derivatives — is **not** implemented.
Extension points exist (`RiskEngine`, `InsuranceProvider`, account types) but
carry no logic. See `docs/adr/`.
