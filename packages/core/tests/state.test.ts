import { AccountStatus, KycStatus, QuoteStatus, TransactionStatus } from '@flt/db';
import { describe, expect, it } from 'vitest';
import {
  accountStateMachine,
  kycStateMachine,
  quoteStateMachine,
  transactionStateMachine,
} from '../src/domain/state';
import { IllegalTransitionError } from '../src/domain/errors';

/**
 * Lifecycle transitions.
 *
 * These tables are what make an illegal state change impossible to express
 * rather than merely discouraged, so the tests assert the transitions that must
 * NOT be possible as much as the ones that must.
 */

describe('account lifecycle', () => {
  it('lets an operator suspend from any state', () => {
    for (const status of Object.values(AccountStatus)) {
      if (status === AccountStatus.SUSPENDED) continue;
      expect(
        accountStateMachine.can(status, AccountStatus.SUSPENDED),
        `${status} -> SUSPENDED`,
      ).toBe(true);
    }
  });

  it('does not let a rejected account become approved without another review', () => {
    // Compliance must look at it again; there is no direct path.
    expect(accountStateMachine.can(AccountStatus.KYC_REJECTED, AccountStatus.KYC_APPROVED)).toBe(
      false,
    );
    expect(accountStateMachine.can(AccountStatus.KYC_REJECTED, AccountStatus.KYC_REVIEW)).toBe(true);
  });

  it('does not let an unverified account jump straight to approved', () => {
    expect(accountStateMachine.can(AccountStatus.PENDING_KYC, AccountStatus.KYC_APPROVED)).toBe(
      false,
    );
  });

  it('throws on an illegal transition rather than silently allowing it', () => {
    expect(() =>
      accountStateMachine.assertTransition(AccountStatus.PENDING_KYC, AccountStatus.KYC_APPROVED),
    ).toThrow(IllegalTransitionError);
  });
});

describe('verification lifecycle', () => {
  it('requires review between submission and a decision', () => {
    expect(kycStateMachine.can(KycStatus.PENDING, KycStatus.APPROVED)).toBe(false);
    expect(kycStateMachine.can(KycStatus.IN_REVIEW, KycStatus.APPROVED)).toBe(true);
  });

  it('allows a rejected submission to be resubmitted', () => {
    expect(kycStateMachine.can(KycStatus.REJECTED, KycStatus.PENDING)).toBe(true);
  });
});

describe('quote lifecycle', () => {
  it('treats every exit from ACTIVE as terminal', () => {
    for (const status of [QuoteStatus.CONSUMED, QuoteStatus.EXPIRED, QuoteStatus.REJECTED]) {
      expect(quoteStateMachine.isTerminal(status), status).toBe(true);
      expect(quoteStateMachine.next(status)).toHaveLength(0);
    }
  });

  it('never lets a consumed quote be reused', () => {
    // This is what stops one quote producing two trades.
    expect(quoteStateMachine.can(QuoteStatus.CONSUMED, QuoteStatus.ACTIVE)).toBe(false);
    expect(quoteStateMachine.can(QuoteStatus.EXPIRED, QuoteStatus.ACTIVE)).toBe(false);
  });
});

describe('transaction lifecycle', () => {
  it('lets a dropped transaction come back', () => {
    // A transaction evicted from the mempool can be re-mined, so DROPPED is
    // not terminal and does not need a new record.
    expect(transactionStateMachine.isTerminal(TransactionStatus.DROPPED)).toBe(false);
    expect(transactionStateMachine.can(TransactionStatus.DROPPED, TransactionStatus.CONFIRMED)).toBe(
      true,
    );
  });

  it('never lets a settled transaction change', () => {
    for (const status of [
      TransactionStatus.CONFIRMED,
      TransactionStatus.REVERTED,
      TransactionStatus.FAILED,
    ]) {
      expect(transactionStateMachine.isTerminal(status), status).toBe(true);
      expect(transactionStateMachine.next(status)).toHaveLength(0);
    }
  });

  it('does not let a confirmed transaction be reverted after the fact', () => {
    expect(
      transactionStateMachine.can(TransactionStatus.CONFIRMED, TransactionStatus.REVERTED),
    ).toBe(false);
  });
});
