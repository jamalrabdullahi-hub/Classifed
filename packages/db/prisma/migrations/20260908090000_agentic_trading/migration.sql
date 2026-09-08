-- CreateEnum
CREATE TYPE "TradingAgentStatus" AS ENUM ('DISABLED', 'PENDING_AUTHORIZATION', 'ACTIVE', 'KILL_SWITCHED');

-- CreateEnum
CREATE TYPE "AgentDecisionAction" AS ENUM ('OPEN', 'CLOSE', 'HOLD', 'REJECTED');

-- CreateTable
CREATE TABLE "trading_agents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "TradingAgentStatus" NOT NULL DEFAULT 'DISABLED',
    "disclosureVersion" TEXT NOT NULL,
    "disclosureAcceptedAt" TIMESTAMP(3) NOT NULL,
    "allocatedUsdHyperliquid" TEXT,
    "allocatedUsdOstium" TEXT,
    "maxLeverage" INTEGER NOT NULL,
    "symbols" TEXT NOT NULL DEFAULT 'BTC,ETH',
    "protectionRequired" BOOLEAN NOT NULL DEFAULT true,
    "killSwitchedAt" TIMESTAMP(3),
    "killSwitchReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_signing_keys" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "venueSlug" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "authorizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_signing_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_decisions" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "venueSlug" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contextJson" TEXT NOT NULL,
    "rawResponse" TEXT NOT NULL,
    "action" "AgentDecisionAction" NOT NULL,
    "side" "PerpSide",
    "leverage" INTEGER,
    "usdNotional" TEXT,
    "reasoning" TEXT,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "rejectionReason" TEXT,
    "orderId" TEXT,

    CONSTRAINT "agent_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trading_agents_userId_key" ON "trading_agents"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_signing_keys_agentId_venueSlug_key" ON "agent_signing_keys"("agentId", "venueSlug");

-- CreateIndex
CREATE INDEX "agent_decisions_agentId_requestedAt_idx" ON "agent_decisions"("agentId", "requestedAt");

-- AddForeignKey
ALTER TABLE "trading_agents" ADD CONSTRAINT "trading_agents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_signing_keys" ADD CONSTRAINT "agent_signing_keys_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "trading_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "trading_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
