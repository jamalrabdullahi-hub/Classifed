# ADR 0004 — Custodial omnibus architecture

**Status:** Accepted · **Date:** 2026-09-11
**Supersedes:** ADR 0001 (non-custodial architecture)

## Context

ADR 0001 committed FLT to a strictly non-custodial model: it held no keys, no
funds, and no internal ledger of value; the chain was the only source of truth
for a participant's balance and the participant's own wallet signed every
transaction.

The operator has since decided to offer a simpler product for a low-information
audience: a participant moves stablecoin (USDC/USDT) or fiat into FLT, sees a
balance they can trade, and trades against pooled funds without ever thinking
about a wallet, a chain or a gas fee. That is a **custodial** product. It cannot
be built on ADR 0001, so this ADR reverses it.

Much of the machinery ADR 0001 forbade already exists in the tree and is
retained rather than rebuilt: a double-entry custody ledger
(`LedgerAccount`/`LedgerTransfer`/`LedgerEntry`, `packages/core/src/services/ledger.ts`),
a `CustodyProvider` port (`packages/core/src/ports/custody.ts`), and
server-side signing through Privy (`packages/providers/src/wallet-provisioning/signer.ts`).
What did not exist — a wallet FLT controls in aggregate, deposit credit,
trade settlement and reconciliation — is what this ADR authorises building.

## Decision

1. **Omnibus.** FLT operates a single pooled wallet (per asset-class of chain)
   whose key material lives in **Privy's** MPC infrastructure and which FLT
   controls. Client assets across all participants sit here.

2. **The ledger is the source of truth.** A participant's balance and their
   displayed "buying power" are the `USER_AVAILABLE` ledger balance for the
   asset — not an on-chain read of a wallet they control. The chain is consulted
   for prices, for what the omnibus actually holds, and for settlement receipts;
   it is no longer the answer to "what does this participant own".

3. **Deposits credit the ledger.** Crypto sent to a participant's deposit
   address is swept to the omnibus; once the sweep is mined, a `DEPOSIT`
   transfer credits the participant's `USER_AVAILABLE` account, idempotent on
   the on-chain reference. Fiat is matched by an operator, converted, and
   credited the same way. A deposit is not owed to the participant until an
   on-chain receipt or a bank statement proves the money arrived.

4. **Execution is server-side.** A quote is built against the omnibus and
   signed by FLT through Privy. On confirmation, a `TRADE_SETTLEMENT` transfer
   moves the participant's value from `USER_AVAILABLE` in the sold asset to
   `USER_AVAILABLE` in the bought asset, with FLT's fee to `FEE_REVENUE`. The
   participant never signs and never needs a wallet.

5. **Withdrawals debit the ledger.** A withdrawal locks the balance, the omnibus
   sends on-chain (or an operator pays out fiat), and the ledger is debited only
   against a mined receipt.

6. **Reconciliation is mandatory.** A job compares the omnibus's on-chain
   balance per asset against `totalClientLiability()` from the ledger.
   Divergence raises an alert. It never writes a ledger balance to match the
   chain — that would cancel the only check that proves the ledger is solvent.

## What this makes FLT, and what it owes

FLT is now a **custodian and, on the fiat leg, a money transmitter**. The
obligations are real and are not discharged by code:

- Client assets must be held segregated from operator funds. The
  `CLIENT_OMNIBUS` account is kept separate from `FEE_REVENUE` for exactly this
  reason; commingling the two is the most common way a custodian fails.
- The ledger must be provably backed at all times. `totalClientLiability` must
  never exceed what the omnibus holds. The reconciliation job is the control
  that keeps this true, and it is not optional.
- Licensing, safeguarding and (where applicable) capital requirements are the
  operator's to establish in each jurisdiction before client funds are accepted.

## Consequences

- **The ledger becomes a store of value.** This is the sentence ADR 0001 ended
  with a prohibition on, and it is now the design. Every guardrail that made the
  ledger safe to have — zero-sum transfers enforced by a deferred constraint,
  the per-account sign convention, `(kind, reference)` uniqueness for
  idempotency, `recomputeBalance` to catch drift — matters more under custody,
  not less, because the number they protect is now the one a participant is paid.
- **Single-wallet concentration.** A pooled wallet is one honeypot. Privy's MPC
  removes a single extractable key, but the operational key FLT uses to
  instruct signing must be treated as a production secret and the omnibus
  balance as an incident-severity asset.
- **Settlement is asynchronous and can fail after success is returned.** The
  existing `Transaction` lifecycle and event log are retained and become the
  record that ties a ledger movement to an on-chain fact.
- **Reversibility is gone.** A settled trade or withdrawal cannot be un-signed.
  Corrections are `ADJUSTMENT` transfers that are attributed and reasoned, never
  silent edits.

## Rejected alternative

**Keep the non-custodial model (ADR 0001).** Rejected by the operator: it makes
every participant learn wallets and gas, which is the friction the product
exists to remove. The cost of removing that friction is everything above.
