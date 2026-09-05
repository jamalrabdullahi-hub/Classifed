# Cloudflare Workers

**Status: incomplete. The Worker builds and serves, but every route that touches
the database returns 500.** Do not deploy this expecting a working application.

The working deployment is the Ubuntu server described in
[deployment.md](deployment.md). This document records how far the Workers path
got, what blocks it, and what would finish it — so the next attempt does not
rediscover the same wall.

## What works

- `npm run cf:build` produces `.open-next/worker.js` without errors.
- `npx wrangler dev` boots it on workerd.
- `/login`, `/register` and every other page that does not query Postgres render
  correctly, HTTP 200.
- `/admin` correctly redirects an anonymous visitor to `/login`, so middleware,
  routing, sessions and `node:crypto` (scrypt, HKDF, AES-GCM) all work on
  workerd. Node compatibility is not the problem.

## What does not

Every database-backed route — `/api/assets`, `/api/auth/register`, the whole
admin panel — returns 500 with:

```
Prisma Client could not locate the Query Engine for runtime "debian-openssl-1.1.x".
This happened because Prisma Client was generated for "windows", but the actual
deployment required "debian-openssl-1.1.x".
```

The message is misleading. The real problem is not a missing binary for a
platform — it is that **workerd cannot load a native query engine at all**, and
the client is still trying to.

## Why

Prisma's generated client publishes export conditions:

```
"node":    "./index.js"    <- native Rust engine
"workerd": "./wasm.js"     <- WASM engine
```

The `workerd` condition points at exactly the right build. It never gets
selected, because Next compiles the server bundle with a **Node** target, so
`@prisma/client` resolves through the `node` condition long before OpenNext or
workerd sees it. Under `nodejs_compat` the runtime then looks like Node, so
nothing downstream corrects the choice.

Three things were tried, none sufficient:

1. **`driverAdapters` + `@prisma/adapter-pg`.** Necessary but not sufficient —
   an adapter changes how queries reach Postgres, not whether the Rust engine is
   loaded. *This change was kept*: both runtimes now go through the adapter, and
   all 208 tests pass on it.
2. **`queryCompiler` preview feature.** Intended to emit an engine-free client.
   With the `prisma-client-js` generator it had no effect — the generated client
   still reported `engineType: "library"`.
3. **Removing `@prisma/client` from `serverExternalPackages`,** so Next would
   bundle it and the `workerd` condition could apply. It still resolved `node`.

## What would finish it

Prisma's newer `prisma-client` generator (not `prisma-client-js`) emits
TypeScript with a selectable `runtime`. Generating twice gives each environment
the right client:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
  runtime  = "nodejs"
}

generator clientEdge {
  provider = "prisma-client"
  output   = "../src/generated/prisma-edge"
  runtime  = "workerd"
}
```

Then `src/server/db.ts` picks by runtime, as it already does for the connection
string. Work involved:

- Repoint 22 files from `@prisma/client` to the generated output.
- Reconcile the two generated clients' types where they meet in `db.ts`.
- Re-run the full suite on the Node client — the ledger's `SERIALIZABLE`
  transactions, deferred constraint triggers, `40001` retry loop and `P2002`
  detection all have to behave identically.

Estimate: half a day, most of it verification rather than typing.

## The other half: the database

Even with the client fixed, Workers still needs Postgres it can reach. The
server's PostgreSQL listens on `127.0.0.1` and must stay that way. So a Workers
deployment needs a *different* database — a managed provider (Neon, Supabase,
Prisma Postgres), ideally behind Hyperdrive for pooling.

`src/server/db.ts` already handles this: it prefers a `HYPERDRIVE` binding and
falls back to a `DATABASE_URL` secret. `wrangler.jsonc` has the Hyperdrive block
commented out with instructions.

**Hyperdrive query caching must stay disabled.** It is off by default. A cached
read of a balance is a wrong balance, and this application settles money on what
it reads.

Migrations cannot run from a Worker. `prisma migrate deploy` has to run from CI
or a workstation against the managed database.

## Deploying, once the above is done

```bash
npx wrangler secret put APP_SECRET      # openssl rand -base64 48
npx wrangler secret put DATABASE_URL    # only if not using Hyperdrive
npm run cf:deploy
```

`wrangler.jsonc` sets `"name": "classifed2"`. It must match the Worker in the
dashboard — a mismatch produces:

```
Service binding 'WORKER_SELF_REFERENCE' references Worker 'x' which was not found
```

If that appears, delete any hand-added `WORKER_SELF_REFERENCE` binding under
**Workers → your worker → Settings → Bindings**. OpenNext creates that binding
itself; a manual one pinned to a stale name overrides it.

## Recommendation

Two runtimes means two sets of database semantics to trust for a system whose
whole point is that the ledger is always right. Until there is a reason to be on
Workers, the single Node deployment is less to get wrong.

If the goal is a global edge presence, the cheaper route is keeping the app on a
server and putting Cloudflare in front of it — Tunnel or proxy — which gives
TLS, DDoS protection and caching of static assets without changing how a single
database query executes.
