import { describe, expect, it } from 'vitest';
import { blockedEmailReason, emailDomain } from '../src/domain/email-domains';

/**
 * The addresses that actually turned up as probe accounts are the test cases:
 * example.com (undeliverable by standard), mailinator.com and maxxspace.com
 * (public throwaway inboxes).
 */
describe('blockedEmailReason', () => {
  it('accepts the addresses real customers use', () => {
    for (const email of [
      'jamal@gmail.com',
      'aamina@hotmail.com',
      'user@yahoo.co.uk',
      'ops@ftlexchange.com',
      'name.surname@outlook.com',
    ]) {
      expect(blockedEmailReason(email)).toBeNull();
    }
  });

  it('refuses domains that can never receive mail', () => {
    expect(blockedEmailReason('flt.test.1791315846@example.com')).toBe('undeliverable');
    expect(blockedEmailReason('x@test')).toBe('undeliverable');
    expect(blockedEmailReason('x@localhost')).toBe('undeliverable');
    expect(blockedEmailReason('x@anything.invalid')).toBe('undeliverable');
  });

  it('refuses public throwaway inboxes, including subdomains', () => {
    expect(blockedEmailReason('probe6439@mailinator.com')).toBe('disposable');
    expect(blockedEmailReason('ftlx13c6a74de16d@maxxspace.com')).toBe('disposable');
    expect(blockedEmailReason('x@team.mailinator.com')).toBe('disposable');
    expect(blockedEmailReason('x@yopmail.com')).toBe('disposable');
  });

  it('treats a malformed address as undeliverable', () => {
    expect(blockedEmailReason('no-at-sign')).toBe('undeliverable');
    expect(blockedEmailReason('@nothing.com')).toBe('undeliverable');
    expect(blockedEmailReason('trailing@')).toBe('undeliverable');
  });

  it('reads the domain case-insensitively', () => {
    expect(emailDomain('Person@Example.COM')).toBe('example.com');
    expect(blockedEmailReason('Person@MAILINATOR.com')).toBe('disposable');
  });
});
