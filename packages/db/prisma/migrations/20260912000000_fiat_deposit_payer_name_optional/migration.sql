-- The EVC deposit rail is matched by phone, not name: an EVC Plus participant
-- only gives the number they paid from. Make payerName optional.
ALTER TABLE "fiat_deposits" ALTER COLUMN "payerName" DROP NOT NULL;
