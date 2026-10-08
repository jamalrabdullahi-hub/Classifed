/**
 * Email domains registration refuses.
 *
 * Two kinds, refused for different reasons:
 *
 *   - **Undeliverable by standard.** `example.com`, `test`, `invalid` and
 *     friends are reserved by RFC 2606/6761 and can never receive mail. An
 *     account on one of these can never confirm its address or recover a
 *     password, so it is only ever a script's account.
 *   - **Disposable inboxes.** Public throwaway mail (Mailinator and the rest)
 *     is how sign-up spam and probe accounts arrive. Blocking the common ones
 *     is not airtight — there are thousands of such domains — but it stops the
 *     default tooling, and the real customers in this market use Gmail,
 *     Hotmail, Yahoo or their own domain.
 *
 * This is checked on the way in, so a fake address never reaches the
 * compliance queue.
 */

/** Reserved by standard: mail to these can never be delivered. */
const UNDELIVERABLE = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.edu',
  'test',
  'invalid',
  'localhost',
  'local',
  'localdomain',
  'test.com',
  'domain.com',
  'email.com',
  'mail.com',
  'none.com',
  'nowhere.com',
  'null.com',
]);

/** Public disposable-inbox providers seen in sign-up spam. */
const DISPOSABLE = new Set([
  'mailinator.com',
  'maxxspace.com',
  '10minutemail.com',
  '10minutemail.net',
  'guerrillamail.com',
  'guerrillamail.info',
  'sharklasers.com',
  'grr.la',
  'yopmail.com',
  'yopmail.fr',
  'temp-mail.org',
  'tempmail.com',
  'tempmailo.com',
  'trashmail.com',
  'trashmail.de',
  'dispostable.com',
  'getnada.com',
  'nada.email',
  'mohmal.com',
  'fakeinbox.com',
  'throwawaymail.com',
  'maildrop.cc',
  'maildrop.cc',
  'inboxkitten.com',
  'emailondeck.com',
  'tempr.email',
  'discard.email',
  'spam4.me',
  'mytemp.email',
  'moakt.com',
  'tmpmail.org',
  'burnermail.io',
  'anonaddy.me',
  'mailnesia.com',
  'harakirimail.com',
  'crazymailing.com',
  'byom.de',
]);

export type BlockedEmailReason = 'undeliverable' | 'disposable';

/** The domain part, lowercased, or null when the address has no usable one. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * Why this address is refused, or null when it is acceptable.
 *
 * Subdomains count: `probe@mail.mailinator.com` is the same inbox provider as
 * `probe@mailinator.com`, and scripts rotate subdomains to get past a plain
 * exact-match list.
 */
export function blockedEmailReason(email: string): BlockedEmailReason | null {
  const domain = emailDomain(email);
  if (!domain) return 'undeliverable';

  const matches = (set: Set<string>) => {
    if (set.has(domain)) return true;
    return [...set].some((blocked) => domain.endsWith(`.${blocked}`));
  };

  if (matches(UNDELIVERABLE)) return 'undeliverable';
  if (matches(DISPOSABLE)) return 'disposable';
  return null;
}

/** Counts, for the admin view and for tests that assert the list is loaded. */
export const BLOCKED_EMAIL_DOMAIN_COUNT = UNDELIVERABLE.size + DISPOSABLE.size;
