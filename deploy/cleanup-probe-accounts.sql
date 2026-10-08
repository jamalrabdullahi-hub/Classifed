-- Suspend the probe accounts and clear their submissions from the queue.
--
--   sudo -u postgres psql -d flt_exchange -f /opt/flt-exchange/deploy/cleanup-probe-accounts.sql
--
-- Accounts are suspended, not deleted: the rows are the evidence of what
-- happened, the audit trail points at them, and a deleted user id in an audit
-- log is worse than a disabled account. Nothing here touches money, because
-- none of these accounts has any — run the balance check at the end and stop
-- if it reports anything but zero.

BEGIN;

-- Who is in scope: addresses that can never receive mail, and public
-- throwaway inboxes. Same rule the application now enforces at sign-up.
CREATE TEMP TABLE probe_users AS
SELECT id, email
FROM users
WHERE email LIKE '%@example.com'
   OR email LIKE '%@example.org'
   OR email LIKE '%@example.net'
   OR email LIKE '%@mailinator.com'
   OR email LIKE '%.mailinator.com'
   OR email LIKE '%@maxxspace.com'
   OR email LIKE '%@yopmail.com'
   OR email LIKE '%@guerrillamail.com'
   OR email LIKE '%@10minutemail.com'
   OR email LIKE '%@trashmail.com'
   OR email LIKE '%@getnada.com'
   OR email LIKE '%@temp-mail.org';

SELECT 'accounts in scope' AS check, count(*) FROM probe_users;

-- Refuse to touch anything holding value. If this returns a row, stop and look.
SELECT 'ACCOUNTS WITH A BALANCE - STOP' AS check, u.email, l.kind, l.asset, l.balance
FROM probe_users u
JOIN ledger_accounts l ON l."userId" = u.id
WHERE l.balance <> 0;

-- Their verification submissions leave the reviewer's queue.
UPDATE kyc_profiles
SET status = 'REJECTED',
    "rejectionReason" = 'Automated submission from an undeliverable or disposable email address',
    "decidedAt" = now()
WHERE "userId" IN (SELECT id FROM probe_users)
  AND status IN ('IN_REVIEW', 'PENDING');

-- Every session ends.
UPDATE user_sessions
SET "revokedAt" = now()
WHERE "userId" IN (SELECT id FROM probe_users)
  AND "revokedAt" IS NULL;

-- The accounts are suspended and cannot trade.
UPDATE users
SET "accountStatus" = 'SUSPENDED',
    "tradingDisabled" = true,
    "tradingApprovedAt" = NULL,
    "suspendedAt" = now(),
    "suspensionReason" = 'Automated probe account (disposable or undeliverable email)'
WHERE id IN (SELECT id FROM probe_users);

SELECT 'suspended' AS result, email FROM probe_users ORDER BY email;

COMMIT;
