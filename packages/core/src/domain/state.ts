import {
  AccountStatus,
  KycStatus,
  QuoteStatus,
  TransactionStatus,
} from '@flt/db';
import { IllegalTransitionError } from './errors.js';

/**
 * A state machine is a plain transition table: state -> allowed next states.
 *
 * Everything that mutates a lifecycle status goes through `assertTransition`,
 * so an illegal move is impossible to express rather than merely discouraged.
 */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export class StateMachine<S extends string> {
  constructor(
    readonly entity: string,
    readonly table: TransitionTable<S>,
    readonly terminal: readonly S[],
  ) {}

  can(from: S, to: S): boolean {
    return (this.table[from] ?? []).includes(to);
  }

  assertTransition(from: S, to: S): void {
    if (!this.can(from, to)) {
      throw new IllegalTransitionError(this.entity, from, to);
    }
  }

  isTerminal(state: S): boolean {
    return this.terminal.includes(state);
  }

  /** Every state reachable in one step. Used to build admin controls. */
  next(from: S): readonly S[] {
    return this.table[from] ?? [];
  }
}

/**
 * Account lifecycle.
 *
 * SUSPENDED is reachable from anywhere — an operator must always be able to
 * stop an account. Leaving suspension returns to KYC_REQUIRED rather than to
 * the previous state, so reinstatement is an explicit compliance decision
 * rather than an automatic restoration of trading rights.
 */
export const accountStateMachine = new StateMachine<AccountStatus>(
  'Account',
  {
    [AccountStatus.PENDING_KYC]: [
      AccountStatus.KYC_REQUIRED,
      AccountStatus.KYC_REVIEW,
      AccountStatus.SUSPENDED,
    ],
    [AccountStatus.KYC_REQUIRED]: [AccountStatus.KYC_REVIEW, AccountStatus.SUSPENDED],
    [AccountStatus.KYC_REVIEW]: [
      AccountStatus.KYC_APPROVED,
      AccountStatus.KYC_REJECTED,
      AccountStatus.KYC_REQUIRED,
      AccountStatus.SUSPENDED,
    ],
    [AccountStatus.KYC_APPROVED]: [AccountStatus.SUSPENDED, AccountStatus.KYC_REVIEW],
    [AccountStatus.KYC_REJECTED]: [AccountStatus.KYC_REVIEW, AccountStatus.SUSPENDED],
    [AccountStatus.SUSPENDED]: [AccountStatus.KYC_REQUIRED, AccountStatus.KYC_APPROVED],
  },
  [],
);

export const kycStateMachine = new StateMachine<KycStatus>(
  'Verification',
  {
    [KycStatus.NOT_STARTED]: [KycStatus.PENDING],
    [KycStatus.PENDING]: [KycStatus.IN_REVIEW, KycStatus.REJECTED],
    [KycStatus.IN_REVIEW]: [KycStatus.APPROVED, KycStatus.REJECTED, KycStatus.PENDING],
    [KycStatus.APPROVED]: [KycStatus.EXPIRED, KycStatus.IN_REVIEW],
    [KycStatus.REJECTED]: [KycStatus.PENDING],
    [KycStatus.EXPIRED]: [KycStatus.PENDING],
  },
  [],
);

/**
 * Quote lifecycle. Every path out of ACTIVE is terminal: a quote is used once,
 * expires, or is refused. It is never reopened.
 */
export const quoteStateMachine = new StateMachine<QuoteStatus>(
  'Quote',
  {
    [QuoteStatus.ACTIVE]: [QuoteStatus.CONSUMED, QuoteStatus.EXPIRED, QuoteStatus.REJECTED],
    [QuoteStatus.CONSUMED]: [],
    [QuoteStatus.EXPIRED]: [],
    [QuoteStatus.REJECTED]: [],
  },
  [QuoteStatus.CONSUMED, QuoteStatus.EXPIRED, QuoteStatus.REJECTED],
);

/**
 * Transaction lifecycle.
 *
 * DROPPED is not terminal: a transaction that fell out of the mempool can be
 * re-mined if it was only temporarily evicted, so the monitor is allowed to
 * move it back to SUBMITTED rather than having to create a new record.
 */
export const transactionStateMachine = new StateMachine<TransactionStatus>(
  'Transaction',
  {
    [TransactionStatus.PENDING]: [TransactionStatus.SUBMITTED, TransactionStatus.FAILED],
    [TransactionStatus.SUBMITTED]: [
      TransactionStatus.CONFIRMED,
      TransactionStatus.REVERTED,
      TransactionStatus.DROPPED,
      TransactionStatus.FAILED,
    ],
    [TransactionStatus.DROPPED]: [
      TransactionStatus.SUBMITTED,
      TransactionStatus.CONFIRMED,
      TransactionStatus.FAILED,
    ],
    [TransactionStatus.CONFIRMED]: [],
    [TransactionStatus.REVERTED]: [],
    [TransactionStatus.FAILED]: [],
  },
  [TransactionStatus.CONFIRMED, TransactionStatus.REVERTED, TransactionStatus.FAILED],
);

/** Statuses the monitor still needs to poll. */
export const OPEN_TRANSACTION_STATUSES: readonly TransactionStatus[] = [
  TransactionStatus.PENDING,
  TransactionStatus.SUBMITTED,
  TransactionStatus.DROPPED,
];
