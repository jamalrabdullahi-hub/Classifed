-- AlterTable
ALTER TABLE "subscription_plans" ADD COLUMN     "dailyTradeLimit" INTEGER,
ADD COLUMN     "perpsAccess" BOOLEAN NOT NULL DEFAULT true;
