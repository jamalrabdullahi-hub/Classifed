# KYCProvider — blocked, vendor not selected

Only `mock.ts` exists. The mock approves at tier 1 immediately so local
development is not blocked; it verifies nobody.

## What is required before a real adapter can be written

### 1. Vendor selection
Driven by a question this code cannot answer: **which documents does the vendor
actually accept for Somali customers?** A vendor with excellent coverage of EU
passports and none of Somali national ID cards or the documents your customers
actually hold is worse than useless.

Establish before committing:
- Accepted document types for Somalia, and their success rates.
- Whether liveness/selfie capture is required, and on what devices.
- Whether the vendor hosts the capture flow (`Verification.redirectUrl`) or
  expects us to upload documents. The current interface supports both, but the
  UI only implements a form; a hosted flow needs a redirect screen.

### 2. API documentation and credentials
- Base URLs, authentication scheme, real credential field names.
- Sandbox keys and test identities that produce each decision outcome.
- Webhook payload schema, signature algorithm, header name, and a stable
  per-event id for the replay guard.

### 3. Compliance policy — a business input, not a technical one
The interface leaves room for all of this; **what** must happen is your decision
and your regulator's:

- Sanctions and PEP screening: which lists, at what frequency, and what happens
  on a hit. Is screening part of the KYC vendor's product or a separate one?
- Ongoing monitoring and re-screening cadence.
- Tiering: what limits attach to what level of verification. `KYCProfile.tier`
  exists and gates trading; the numbers are currently placeholders in
  `src/services/limits.ts`.
- Record retention period and deletion policy. KYC document numbers are stored
  AES-256-GCM encrypted (`src/server/crypto.ts`); retention is unimplemented
  because the required period is unknown.
- Reporting obligations (suspicious activity, thresholds, to whom).
- Somali licensing requirements for operating this business at all.

None of the above is inferable from code, and getting it wrong is a legal
exposure rather than a bug. It needs a compliance decision before launch.

## Contract the adapter must satisfy

Implement `KYCProvider` from `types.ts`. Verification decisions must arrive by
both webhook and polling — a vendor webhook that silently fails must not leave a
customer permanently stuck in `PENDING`.
