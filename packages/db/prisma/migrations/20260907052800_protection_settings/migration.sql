-- CreateEnum
CREATE TYPE "CreditDestination" AS ENUM ('BALANCE', 'POSITION');

-- AlterTable
ALTER TABLE "protection_policies" ADD COLUMN     "creditDestination" "CreditDestination" NOT NULL DEFAULT 'BALANCE';

-- CreateTable
CREATE TABLE "protection_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "reserveAddress" TEXT,
    "operatorAddress" TEXT,
    "operatorFeeBps" INTEGER NOT NULL DEFAULT 1000,
    "creditDestination" "CreditDestination" NOT NULL DEFAULT 'BALANCE',
    "allowCreditChoice" BOOLEAN NOT NULL DEFAULT true,
    "mode" TEXT NOT NULL DEFAULT 'off',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "protection_settings_pkey" PRIMARY KEY ("id")
);
