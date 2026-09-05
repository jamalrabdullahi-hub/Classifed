# WAAFI Pay adapter — blocked, pending documentation

`index.ts` in this directory implements `PaymentProvider` with methods that throw
`ProviderNotConfiguredError`. That is intentional. Nothing here is a guess.

The rest of the application does not know WAAFI exists — it depends on the
`PaymentProvider` interface. When the items below are supplied, only the five
method bodies in `index.ts` change.

Until then: `PAYMENT_PROVIDER=mock`.

## What is required before this adapter can be written

### 1. Endpoints and environments
- Sandbox base URL and production base URL.
- Whether sandbox is a separate host, a separate merchant id, or a flag on the request.

### 2. Authentication
- The scheme (API key header? HMAC-signed request? OAuth client credentials? mTLS?).
- The exact credential field names, so `.env.example` can be corrected. The
  placeholders currently in `.env.example` (`WAAFI_MERCHANT_ID`, `WAAFI_API_KEY`,
  `WAAFI_API_SECRET`) are **assumptions and are probably wrong**.
- Whether credentials differ between collections (deposits) and disbursements (payouts).

### 3. Collections — customer pays the brokerage
- Request schema for initiating a payment request against a customer MSISDN.
- Response schema, including the provider's own transaction identifier.
- How the customer authorises (USSD push? in-app approval? redirect?), and what
  the app must display to them.
- Whether our own reference is echoed back on the transaction and on webhooks.
- The fee model: does WAAFI deduct a fee from the collected amount, invoice it
  separately, or add it on top? The ledger posts a `PROVIDER_FEE_EXPENSE` leg and
  needs to know which.
- Timeout / expiry behaviour for an unapproved request.

### 4. Status query — the out-of-band verification
- The endpoint to query a single transaction by the provider's id.
- Its full response schema, and the complete set of status values, including the
  terminal ones. **This is the call that actually credits a customer** — a webhook
  body alone never does — so its semantics must be exact.

### 5. Disbursements — brokerage pays a customer
- Request and response schema for sending funds to an MSISDN.
- Whether the merchant account is enabled for disbursements at all.
- Whether disbursement is synchronous or requires polling/webhook.
- The status-query endpoint for a disbursement.

### 6. Webhooks
- The payload schema for every event type we must handle.
- The signature algorithm (HMAC-SHA256 over the raw body? over a canonical
  string? RSA?) and **the exact header name** carrying it.
- Whether a timestamp is included in the signed material — without one, a captured
  webhook can be replayed indefinitely.
- **A stable, unique, per-event identifier.** `WebhookEvent` has a unique index on
  `(provider, externalEventId)`; that index is the replay guard. If WAAFI does not
  supply an event id, we must agree a deterministic derivation from the payload
  and document it here.
- Retry policy: how many times, over what window, and whether a redelivery reuses
  the original event id (it must, or dedupe cannot work).
- The source IP ranges to allowlist, if any.

### 7. Operational
- Sandbox merchant credentials and at least one test MSISDN.
- Rate limits.
- Settlement timing — when collected funds actually become available to the
  brokerage. This determines how long the `PAYMENT_CLEARING` ledger account
  legitimately carries a balance, and therefore what the reconciler should treat
  as a stuck deposit rather than a normal one.
- Reversal / chargeback mechanics, if any. `reverseTransaction` in the ledger
  handles the accounting; we need to know what triggers it.

## Test expectations for the real adapter

Once written, the adapter must pass the same contract tests the mock passes
(`tests/unit/providers.test.ts`), plus:

- A replayed webhook (identical body, identical event id) is processed once.
- A webhook with a tampered body fails signature verification and is rejected.
- A `createDeposit` retried with the same idempotency key does not create a
  second payment request at WAAFI.
- A timeout on `createDeposit` followed by a status query does not lose the payment.
