# LiquidityProvider — blocked, venue not selected

Only `mock.ts` exists. No real adapter has been written because no venue has been
chosen and no API documentation or credentials are available.

Nothing outside this directory names a venue. Adding one means adding a file here
and a line in `src/providers/registry.ts`.

## What is required before a real adapter can be written

### 1. The venue decision itself
This is a business decision with consequences the code cannot make for you:
- Does it serve a Somali-registered entity?
- Does it support USD-quoted execution for BTC, ETH, SOL, USDT and USDC?
- Does it offer withdrawals for those assets (this MVP uses the same venue for
  custody — see `src/providers/blockchain/`)?
- What is the minimum order size, and does it sit below our `minTradeUsd` of $5?

### 2. API documentation and credentials
- Base URLs for sandbox and production.
- Authentication scheme and credential field names. The placeholders in
  `.env.example` are assumptions.
- Sandbox keys, funded with test balances.

### 3. Execution semantics — the part that matters most
- **Is execution quote-referenced (RFQ) or market-order based?** `VenueQuote.quoteRef`
  and `PlaceOrderInput.quoteRef` exist for RFQ venues. If the venue only accepts
  market orders, the brokerage carries the price risk between quoting a customer
  and filling, and `EXECUTION_SLIPPAGE_TOLERANCE_BPS` becomes load-bearing rather
  than a safety net.
- Whether orders can be denominated in fiat (buy $100 of BTC) or only in base
  quantity (buy 0.0015 BTC). The buy flow assumes fiat-denominated is possible;
  if it is not, the quote service must round to a quantity first and the residual
  cents need an accounting treatment.
- **Partial fill behaviour**, and whether an unfilled remainder rests as an open
  order or is cancelled. `src/services/order.ts` currently refunds the remainder,
  which assumes the latter.
- Whether `placeOrder` accepts a client-supplied idempotency key. If not, the
  adapter must implement its own dedupe against a client order id, and a timeout
  becomes genuinely dangerous — document the recovery procedure here.
- Fee model: taker fee in bps, charged in quote or base currency, and whether it
  is included in or added to the reported fill price.

### 4. Operational
- Rate limits and burst behaviour.
- Settlement/funding: how USD gets to the venue and how proceeds come back.
- Status-query endpoint semantics after a timeout — the single most important
  recovery path in the whole system.
- Whether the venue pushes execution webhooks or must be polled.

## Contract the adapter must satisfy

Implement `LiquidityProvider` from `types.ts`. It must pass
`tests/unit/providers.test.ts`, and specifically:

- `placeOrder` called twice with the same idempotency key results in one order at
  the venue and returns the same `externalOrderId` both times.
- `getOrderStatus` after a `placeOrder` timeout returns the real state.
- Amounts cross the boundary as decimal strings. No JS numbers.
