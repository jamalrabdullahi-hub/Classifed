# ADR 0001 — Non-custodial architecture

**Status:** Superseded by ADR 0004 (custodial omnibus) · **Date:** 2026-09-05

> **This ADR no longer governs the architecture.** The operator has chosen a
> custodial omnibus model; see `docs/adr/0004-custodial-omnibus.md`. The
> reasoning below is kept as the record of the model we left.

## Context

FLT Exchange must let users trade on decentralized exchanges without FLT taking
possession of their assets. The alternative — pooling customer funds and
executing against them — is explicitly prohibited by the brief and carries money
transmitter obligations we are not structured to meet.

## Decision

FLT holds no keys and no customer funds. The system:

1. Constructs transactions but never signs them.
2. Sends unsigned calldata to the browser, where the user's wallet signs.
3. Observes the chain to learn what happened.

The backend has no code path that can move a user's assets. There is no hot
wallet, no treasury, no internal ledger of customer balances. Balances shown in
the portfolio are read from the chain at request time, not from our database.

## Consequences

- We cannot batch, net, or internalize trades. Every trade is its own on-chain
  transaction paid for by the user.
- We cannot recover from a user error. A user who signs a bad transaction has
  signed it; there is no reversal.
- Our database is a *record* of activity, never a *source of truth* for
  balances. Reconciliation is one-directional: the chain is authoritative.
- Settlement is asynchronous and can fail after we have returned success to the
  user, so every transaction carries an explicit lifecycle state rather than a
  boolean.

## Rejected alternative

A custodial model with an internal double-entry ledger was rejected. It is a
larger system, it makes FLT liable for customer assets, and the brief forbids
it.
