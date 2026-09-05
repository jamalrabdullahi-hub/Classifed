# DexProvider — interface + mock only

`mock.ts` is a simulator. No real aggregator adapter exists, because writing one
means knowing a specific aggregator's actual API, and guessing at it would
produce code that looks finished and loses money on contact with a real pool.

Nothing outside this directory names an aggregator. Adding one is a file here
plus a row in `protocols` and a line in `src/providers/registry.ts`.

## What the mock deliberately does model

These are the behaviours the routing engine is built against, and any real
adapter must reproduce them:

- **Price impact grows superlinearly with size** (constant-product), so a $50k
  order into a shallow pool really is rejected by the impact cap.
- **Multiple routes with different impact, fee and gas**, ranked by output *net
  of gas* rather than by headline output.
- **Simulation that can predict a revert**, run before every submission.
- **An on-chain `minAmountOut` floor** that reverts rather than filling worse.
- **Private vs public submission**, with public submission taking measurably
  more slippage under the `ADVERSE_PRICE_MOVE` scenario.

## What is required before a real adapter can be written

### 1. Choose the aggregator(s) per chain
One decision per chain we support. The relevant questions:
- Does it expose a quote/route API returning **price impact and per-hop routing**,
  or only a final amount? Without impact we cannot enforce the tier caps.
- Does it return a **binding, referenceable route** we can submit later, or must
  we re-quote at submission time?
- Does the router contract enforce `minAmountOut` on-chain? (If not, the floor is
  advisory and the whole slippage-control story is much weaker — say so here.)
- Rate limits, and whether quotes are free.

### 2. API documentation
- Base URLs, auth (many aggregator APIs are keyless for quotes but keyed for
  higher rate limits), and the real credential field names. The `.env.example`
  entries are placeholders.
- Quote/route response schema, including how impact and fees are expressed.
- Transaction-building endpoint: what it returns (calldata? a full unsigned tx?)
  and what we must fill in.

### 3. Signing and submission
**This is the part with no safe default.** The system holds no private keys —
`TreasuryWallet.custodian` names an MPC/custody provider. Required:
- Which custody/MPC provider signs treasury transactions.
- Its API for requesting a signature on arbitrary calldata, and its own policy
  engine (many enforce per-transaction limits themselves — we should use that as
  well as ours, not instead of it).
- Whether it can co-sign within our latency budget. A 30-second quote does not
  survive a 60-second signing ceremony.

### 4. Private / protected submission
- Which protected-transaction service per chain, and its endpoint.
- Whether it guarantees inclusion or merely privacy, and the latency cost.
- Fallback policy when it is unavailable: refuse, or submit publicly with a
  tighter `minAmountOut`? **This is a risk decision, not a technical one.**

### 5. RPC and monitoring
- RPC endpoints (and a fallback provider — a single RPC is a single point of
  failure for the whole execution path).
- How to detect a dropped/replaced transaction, and the replacement policy.
- Reorg depth to wait before treating a swap as final.

## Contract the adapter must satisfy

Implement `DexProvider` from `types.ts`. It must pass
`tests/unit/providers.test.ts`, and specifically:

- `submit` twice with the same idempotency key produces **one** on-chain
  transaction.
- A swap that would return less than `minAmountOut` reverts rather than filling.
- `simulate` is called before every `submit`, and a `WOULD_REVERT` simulation
  prevents submission.
- Amounts cross the boundary as decimal strings. No JS numbers.
