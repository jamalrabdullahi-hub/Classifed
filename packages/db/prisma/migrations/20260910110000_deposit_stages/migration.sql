-- A fiat deposit's four stages, and who the money came from.
--
-- SENT sits between FUNDS_RECEIVED and DELIVERED because a broadcast transfer
-- is not a delivered one. Without it, discharging the debt would rest on an
-- operator pressing a button; with it, DELIVERED can require the transfer to
-- be confirmed in a mined receipt. The enum value itself is added by the
-- preceding migration, alone, because Postgres will not let a new enum value
-- be added and used in the same transaction.
--
-- The payer's name and number are what an operator actually matches a bank or
-- EVC statement line against. The reference code is the primary key of that
-- match, but people forget to include it, and a name and number make the line
-- findable anyway.

ALTER TABLE "fiat_deposits" ADD COLUMN "payerName"  TEXT NOT NULL DEFAULT '';
ALTER TABLE "fiat_deposits" ADD COLUMN "payerPhone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "fiat_deposits" ADD COLUMN "sentAt"     TIMESTAMP(3);
ALTER TABLE "fiat_deposits" ADD COLUMN "sentById"   TEXT;

-- The defaults exist only so the columns can be added to a table that may
-- already hold rows. New rows always carry both, enforced by the service.
ALTER TABLE "fiat_deposits" ALTER COLUMN "payerName"  DROP DEFAULT;
ALTER TABLE "fiat_deposits" ALTER COLUMN "payerPhone" DROP DEFAULT;

ALTER TABLE "fiat_deposits"
  ADD CONSTRAINT "fiat_deposits_sentById_fkey"
  FOREIGN KEY ("sentById") REFERENCES "admin_users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
