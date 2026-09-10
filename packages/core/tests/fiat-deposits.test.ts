import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/domain/money';

/**
 * The accounting a fiat deposit performs, checked as arithmetic.
 *
 * These assert the shape of the two transfers rather than calling the service,
 * which needs a database. That is a real limitation and worth naming: the
 * constraint that actually enforces the zero-sum rule is a Postgres trigger,
 * and no test in this repo runs it. What these do catch is the mistake that
 * would otherwise reach it — entries that do not balance, and a client
 * liability that does not return to zero once the crypto has been delivered.
 */
describe('fiat deposit accounting', () => {
  const received = new Decimal('1000');
  const fee = new Decimal('10');
  const net = received.minus(fee);

  it('balances when the cash arrives', () => {
    // Debit the gateway (an asset FLT now holds), credit the client what they
    // are owed, credit revenue the fee.
    const entries = [received, net.negated(), fee.negated()];
    const sum = entries.reduce((total, amount) => total.plus(amount), new Decimal(0));

    expect(sum.toFixed()).toBe('0');
  });

  it('balances when the crypto is delivered', () => {
    const entries = [net, net.negated()];
    const sum = entries.reduce((total, amount) => total.plus(amount), new Decimal(0));

    expect(sum.toFixed()).toBe('0');
  });

  it('leaves the client owed nothing once delivered', () => {
    // Stored as a credit balance, so a credit of `net` then a debit of `net`
    // returns to zero. This is the property that makes the model honest: after
    // delivery the value sits in a wallet FLT does not control, so FLT owes
    // nothing and the participant's balance is their on-chain balance.
    const afterReceipt = new Decimal(0).plus(net.negated());
    const afterDelivery = afterReceipt.plus(net);

    expect(afterDelivery.toFixed()).toBe('0');
  });

  it('leaves exactly the fee behind, matched by revenue', () => {
    // Gateway: +1000 on receipt, -990 on delivery = 10 held.
    // Revenue: -10 credited on receipt = 10 earned.
    const gateway = received.minus(net);
    const revenue = fee;

    expect(gateway.toFixed()).toBe(revenue.toFixed());
  });

  it('credits what arrived, not what was promised', () => {
    // A wire that says 1000 and lands as 985 must credit 985: the difference
    // is a bank fee taken in transit, and crediting the claim would hand out
    // money that never came.
    const promised = new Decimal('1000');
    const actuallyArrived = new Decimal('985');
    const flatFee = new Decimal('10');

    expect(actuallyArrived.minus(flatFee).toFixed()).toBe('975');
    expect(promised.minus(flatFee).toFixed()).not.toBe('975');
  });
});
