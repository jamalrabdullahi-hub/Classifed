-- Adds the SENT stage to the deposit status enum, alone in its own migration.
--
-- Postgres restricts ALTER TYPE ... ADD VALUE: depending on version and how
-- the statements reach the server, it can be refused inside a transaction
-- block or from a multi-command string, and the new value cannot be used in
-- the same transaction that adds it. Keeping it in a file by itself sidesteps
-- all of that — the columns that follow are added by the next migration, which
-- runs after this one has committed.
ALTER TYPE "FiatDepositStatus" ADD VALUE IF NOT EXISTS 'SENT' BEFORE 'DELIVERED';
