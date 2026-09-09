-- Standing permission for FLT to direct a participant's FLT-provisioned wallet.
--
-- FLT does not hold the key — Privy does — but instructing Privy to sign on
-- somebody's behalf is still a real power, and a participant should not have to
-- infer where the line sits. Granted explicitly, versioned so a change of terms
-- does not carry forward, and revocable.
--
-- The row survives revocation: "this permission existed between these dates" is
-- what an investigation asks, and deleting it answers nothing.

CREATE TABLE "wallet_delegations" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "version"    TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"  TIMESTAMP(3),
  "ip"         TEXT,
  "userAgent"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wallet_delegations_pkey" PRIMARY KEY ("id")
);

-- One per participant: the EVM key is shared across every EVM chain, so consent
-- per wallet row would ask the same question three times and let the answers
-- disagree.
CREATE UNIQUE INDEX "wallet_delegations_userId_key" ON "wallet_delegations" ("userId");

ALTER TABLE "wallet_delegations"
  ADD CONSTRAINT "wallet_delegations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
