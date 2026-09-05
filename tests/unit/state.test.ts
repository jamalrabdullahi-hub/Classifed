import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from '../../src/domain/errors';
import {
  depositMachine,
  orderMachine,
  quoteMachine,
  withdrawalMachine,
} from '../../src/domain/state/index';

describe('state machines', () => {
  describe('order', () => {
    it('allows the happy buy path', () => {
      expect(orderMachine.can('CREATED', 'PENDING_PAYMENT')).toBe(true);
      expect(orderMachine.can('PENDING_PAYMENT', 'PAID')).toBe(true);
      expect(orderMachine.can('PAID', 'EXECUTING')).toBe(true);
      expect(orderMachine.can('EXECUTING', 'FILLED')).toBe(true);
      expect(orderMachine.can('FILLED', 'SETTLED')).toBe(true);
    });

    it('allows a funded account to skip the payment step', () => {
      expect(orderMachine.can('CREATED', 'PAID')).toBe(true);
    });

    it('refuses to settle an order that never executed', () => {
      expect(() => orderMachine.assertTransition('CREATED', 'SETTLED')).toThrow(
        IllegalTransitionError,
      );
      expect(() => orderMachine.assertTransition('PENDING_PAYMENT', 'FILLED')).toThrow(
        IllegalTransitionError,
      );
    });

    it('refuses to move out of a terminal state', () => {
      expect(orderMachine.next('SETTLED')).toEqual([]);
      expect(orderMachine.next('REFUNDED')).toEqual([]);
      expect(() => orderMachine.assertTransition('SETTLED', 'EXECUTING')).toThrow();
      expect(() => orderMachine.assertTransition('REFUNDED', 'PAID')).toThrow();
    });

    it('routes a partial fill to settlement or refund', () => {
      expect(orderMachine.can('PARTIALLY_FILLED', 'SETTLED')).toBe(true);
      expect(orderMachine.can('PARTIALLY_FILLED', 'REFUNDED')).toBe(true);
    });
  });

  describe('deposit', () => {
    it('requires confirmation before crediting', () => {
      expect(depositMachine.can('AWAITING_PAYMENT', 'CREDITED')).toBe(false);
      expect(depositMachine.can('CONFIRMED', 'CREDITED')).toBe(true);
    });

    it('allows a credited deposit to be reversed but not re-credited', () => {
      expect(depositMachine.can('CREDITED', 'REVERSED')).toBe(true);
      expect(depositMachine.can('CREDITED', 'CREDITED')).toBe(false);
    });

    it('treats failure and expiry as terminal', () => {
      expect(depositMachine.isTerminal('FAILED')).toBe(true);
      expect(depositMachine.isTerminal('EXPIRED')).toBe(true);
      expect(() => depositMachine.assertTransition('FAILED', 'CREDITED')).toThrow();
    });
  });

  describe('withdrawal', () => {
    it('requires confirmation before submission', () => {
      expect(withdrawalMachine.can('AWAITING_CONFIRMATION', 'SUBMITTED')).toBe(false);
      expect(withdrawalMachine.can('CONFIRMED', 'SUBMITTED')).toBe(true);
    });

    it('allows a first poll to observe an already-confirmed transaction', () => {
      expect(withdrawalMachine.can('SUBMITTED', 'COMPLETED')).toBe(true);
      expect(withdrawalMachine.can('SUBMITTED', 'BROADCAST')).toBe(true);
    });

    it('allows failure from every in-flight state, so a hold can always be released', () => {
      for (const state of ['REQUESTED', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'SUBMITTED', 'BROADCAST'] as const) {
        expect(withdrawalMachine.can(state, 'FAILED')).toBe(true);
      }
    });

    it('refuses to complete a withdrawal that was never submitted', () => {
      expect(() => withdrawalMachine.assertTransition('REQUESTED', 'COMPLETED')).toThrow();
      expect(() => withdrawalMachine.assertTransition('CONFIRMED', 'COMPLETED')).toThrow();
    });
  });

  describe('quote', () => {
    it('is single-use and cannot be revived', () => {
      expect(quoteMachine.can('ACTIVE', 'CONSUMED')).toBe(true);
      expect(quoteMachine.can('CONSUMED', 'ACTIVE')).toBe(false);
      expect(quoteMachine.can('EXPIRED', 'CONSUMED')).toBe(false);
    });
  });

  describe('error detail', () => {
    it('names the entity and both states', () => {
      try {
        orderMachine.assertTransition('SETTLED', 'PAID');
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(IllegalTransitionError);
        const e = error as IllegalTransitionError;
        expect(e.message).toContain('Order');
        expect(e.message).toContain('SETTLED');
        expect(e.message).toContain('PAID');
        expect(e.status).toBe(409);
      }
    });
  });
});
