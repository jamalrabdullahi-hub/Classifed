# ScreeningProvider — interface + mock only

`mock.ts` produces deterministic verdicts from a hash of the address. It screens
nobody. It exists so the accept / review / reject paths are exercised.

## Why this matters more here than almost anywhere else

Somalia is treated as high-risk by most correspondent banks and exchanges. That
is the reason this brokerage sources liquidity on-chain in the first place. The
consequence is that **blockchain analytics is not a nice-to-have — it is the
control that makes the rest of the model defensible.** It is what lets you say to
a future counterparty, regulator or bank: every satoshi that entered this
business was screened, scored, and either accepted with a record or rejected.

FATF guidance on DeFi turns on whether a person or entity exercises control or
sufficient influence over an arrangement, rather than on whether something calls
itself decentralised. A brokerage that routes customer orders through DEXs is
exercising exactly that kind of control, and is expected to apply AML/CFT
controls accordingly. The architecture here — permissionless liquidity behind a
permissioned brokerage — is built on that assumption.

## What is required before a real adapter can be written

### 1. Vendor selection
- Chain coverage for every chain we route on. A vendor with excellent Ethereum
  coverage and nothing on Solana is only half a control.
- Whether they offer **real-time address screening** (needed inline, before we
  credit or send) or only batch/retrospective analysis.
- Latency. Screening sits in the deposit-credit path; a 30-second call changes
  the flow design.
- Sanctions list coverage and refresh cadence.

### 2. API documentation and credentials
- Base URLs, auth scheme, real credential field names. The `.env.example`
  entries are placeholders.
- Response schema: their risk taxonomy, score range, and how exposure is
  expressed (direct vs indirect, hop count, share of volume). `RiskCategory` in
  `types.ts` is our normalized vocabulary; the adapter maps theirs onto it.
- Rate limits and pricing per query — this runs on every deposit and withdrawal,
  so per-call cost is a real operating expense.

### 3. Policy — a compliance decision, not a technical one
The mechanism is built and enforced in `src/services/screening.ts`. The
**thresholds are placeholders**. Before launch, someone accountable must decide:

- What risk level blocks an inbound deposit outright, versus holds it for review.
- The same for outbound withdrawals (our policy is deliberately stricter
  outbound — sending funds to a sanctioned address is a far worse outcome than
  receiving from a merely suspicious one).
- What happens to funds already credited when a later screen comes back dirty.
  The ledger supports reversal; the *policy* on when to use it is yours.
- How long a screening result stays valid before re-screening.
- Who reviews the REVIEW queue, within what SLA, and what they may see.
- Escalation and reporting obligations on a confirmed sanctions hit — including
  whether the funds must be frozen rather than returned.
- Record retention for screening results.

### 4. Operational
- A documented false-positive appeal path. Blocking a real customer's legitimate
  withdrawal on a 3-hops-from-a-gambling-site finding will happen, and needs an
  answer that is not "email support and hope".
