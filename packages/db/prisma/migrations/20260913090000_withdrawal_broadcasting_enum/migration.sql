-- A withdrawal whose broadcast outcome is not yet known.
--
-- In its own migration because Postgres will not let an enum value be added and
-- then used in the same transaction. Nothing here references the new value; the
-- columns that go with it are added by the migration that follows.
ALTER TYPE "WithdrawalStatus" ADD VALUE IF NOT EXISTS 'BROADCASTING';
