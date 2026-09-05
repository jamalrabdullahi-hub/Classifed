import { StateMachine, type TransitionTable } from './machine';

export { StateMachine };
export type { TransitionTable };

// --- Order -----------------------------------------------------------------
// BUY:  CREATED -> PENDING_PAYMENT -> PAID -> EXECUTING -> FILLED/PARTIALLY_FILLED -> SETTLED
// SELL: CREATED -> EXECUTING -> FILLED/PARTIALLY_FILLED -> SETTLED
// A funded account skips PENDING_PAYMENT entirely (CREATED -> PAID).

export type OrderState =
  | 'CREATED'
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'EXECUTING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'SETTLED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED';

const orderTable: TransitionTable<OrderState> = {
  CREATED: ['PENDING_PAYMENT', 'PAID', 'EXECUTING', 'CANCELLED', 'FAILED'],
  PENDING_PAYMENT: ['PAID', 'CANCELLED', 'FAILED'],
  // FAILED from PAID means we hold the customer's money and owe them a refund.
  PAID: ['EXECUTING', 'FAILED', 'CANCELLED'],
  EXECUTING: ['FILLED', 'PARTIALLY_FILLED', 'FAILED'],
  // A partial fill settles the filled portion and refunds the remainder.
  PARTIALLY_FILLED: ['SETTLED', 'REFUNDED', 'FAILED'],
  FILLED: ['SETTLED', 'FAILED'],
  SETTLED: [],
  FAILED: ['REFUNDED'],
  CANCELLED: ['REFUNDED'],
  REFUNDED: [],
};

export const orderMachine = new StateMachine<OrderState>('Order', orderTable, [
  'SETTLED',
  'REFUNDED',
]);

// --- Deposit ---------------------------------------------------------------

export type DepositState =
  | 'PENDING'
  | 'AWAITING_PAYMENT'
  | 'CONFIRMED'
  | 'CREDITED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REVERSED';

const depositTable: TransitionTable<DepositState> = {
  PENDING: ['AWAITING_PAYMENT', 'CONFIRMED', 'FAILED', 'EXPIRED'],
  AWAITING_PAYMENT: ['CONFIRMED', 'FAILED', 'EXPIRED'],
  // CONFIRMED means the provider verified the payment out-of-band.
  // CREDITED means the ledger entries exist. The gap between them is the
  // window the reconciler watches.
  CONFIRMED: ['CREDITED', 'FAILED'],
  CREDITED: ['REVERSED'],
  FAILED: [],
  EXPIRED: [],
  REVERSED: [],
};

export const depositMachine = new StateMachine<DepositState>('Deposit', depositTable, [
  'FAILED',
  'EXPIRED',
  'REVERSED',
]);

// --- Withdrawal ------------------------------------------------------------

export type WithdrawalState =
  | 'REQUESTED'
  | 'AWAITING_CONFIRMATION'
  | 'CONFIRMED'
  | 'SUBMITTED'
  | 'BROADCAST'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REVERSED';

const withdrawalTable: TransitionTable<WithdrawalState> = {
  REQUESTED: ['AWAITING_CONFIRMATION', 'CANCELLED', 'FAILED'],
  AWAITING_CONFIRMATION: ['CONFIRMED', 'CANCELLED', 'FAILED'],
  // Funds are held on the ledger from CONFIRMED onward, so they cannot be spent twice.
  CONFIRMED: ['SUBMITTED', 'FAILED', 'CANCELLED'],
  // SUBMITTED means the provider accepted it. Outcome is now unknown until polled;
  // FAILED here must release the hold. COMPLETED is reachable directly because
  // the first poll can find the transaction already fully confirmed.
  SUBMITTED: ['BROADCAST', 'COMPLETED', 'FAILED'],
  BROADCAST: ['COMPLETED', 'FAILED'],
  COMPLETED: ['REVERSED'],
  FAILED: ['REVERSED'],
  CANCELLED: ['REVERSED'],
  REVERSED: [],
};

export const withdrawalMachine = new StateMachine<WithdrawalState>(
  'Withdrawal',
  withdrawalTable,
  ['COMPLETED', 'REVERSED'],
);

// --- Quote -----------------------------------------------------------------

export type QuoteState = 'ACTIVE' | 'CONSUMED' | 'EXPIRED';

const quoteTable: TransitionTable<QuoteState> = {
  ACTIVE: ['CONSUMED', 'EXPIRED'],
  CONSUMED: [],
  EXPIRED: [],
};

export const quoteMachine = new StateMachine<QuoteState>('Quote', quoteTable, [
  'CONSUMED',
  'EXPIRED',
]);

// --- KYC -------------------------------------------------------------------

export type KycState =
  | 'NOT_STARTED'
  | 'PENDING'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED';

const kycTable: TransitionTable<KycState> = {
  NOT_STARTED: ['PENDING'],
  PENDING: ['IN_REVIEW', 'APPROVED', 'REJECTED'],
  IN_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['EXPIRED', 'IN_REVIEW'],
  REJECTED: ['PENDING'],
  EXPIRED: ['PENDING'],
};

export const kycMachine = new StateMachine<KycState>('KycProfile', kycTable, []);
