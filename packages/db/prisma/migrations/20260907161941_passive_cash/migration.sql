-- CreateEnum
CREATE TYPE "PassiveCashEntryKind" AS ENUM ('CONTRIBUTION', 'WITHDRAWAL', 'PROFIT_SHARE', 'LOSS');

-- CreateTable
CREATE TABLE "passive_cash_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "balance" TEXT NOT NULL DEFAULT '0',
    "lifetimeEarned" TEXT NOT NULL DEFAULT '0',
    "lifetimeLost" TEXT NOT NULL DEFAULT '0',
    "tokenAddress" TEXT,
    "chainId" INTEGER,
    "profitShareBps" INTEGER NOT NULL DEFAULT 5000,
    "lossShareBps" INTEGER NOT NULL DEFAULT 10000,
    "disclosureVersion" TEXT,
    "disclosureAcceptedAt" TIMESTAMP(3),
    "enabledAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "passive_cash_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passive_cash_entries" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" "PassiveCashEntryKind" NOT NULL,
    "amount" TEXT NOT NULL,
    "balanceAfter" TEXT NOT NULL,
    "grossAmount" TEXT,
    "shareBps" INTEGER,
    "reason" TEXT,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passive_cash_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "passive_cash_accounts_userId_key" ON "passive_cash_accounts"("userId");

-- CreateIndex
CREATE INDEX "passive_cash_entries_accountId_createdAt_idx" ON "passive_cash_entries"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "passive_cash_accounts" ADD CONSTRAINT "passive_cash_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passive_cash_entries" ADD CONSTRAINT "passive_cash_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "passive_cash_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
