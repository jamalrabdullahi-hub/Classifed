-- PayPal as a fiat deposit method.
--
-- In its own migration because Postgres will not let an enum value be added
-- and used in the same transaction. Nothing here references the new value.
ALTER TYPE "FiatDepositMethod" ADD VALUE IF NOT EXISTS 'PAYPAL';
