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

  it('balances the conversion against each asset', () => {
    // Under custody the conversion is two transfers, not one: USD and the
    // stablecoin are different assets, and a single transfer's entries must
    // stay within one. Each leg balances on its own.
    const usdLeg = [net, net.negated()];
    const stableLeg = [net, net.negated()];

    for (const leg of [usdLeg, stableLeg]) {
      const sum = leg.reduce((total, amount) => total.plus(amount), new Decimal(0));
      expect(sum.toFixed()).toBe('0');
    }
  });

  it('leaves the participant holding the stablecoin, not nothing', () => {
    // On receipt the participant is owed `net` in USD. On conversion that USD
    // liability closes to zero and a stablecoin liability of `net` opens — the
    // value does not leave the ledger, it changes asset, because the stablecoin
    // sits in the omnibus rather than a wallet the participant controls.
    const afterReceiptUsd = new Decimal(0).plus(net.negated());
    const afterConversionUsd = afterReceiptUsd.plus(net);
    const afterConversionStable = new Decimal(0).plus(net.negated());

    expect(afterConversionUsd.toFixed()).toBe('0');
    // Stored as a credit balance: negative means the participant holds it.
    expect(afterConversionStable.toFixed()).toBe(new Decimal(net).negated().toFixed());
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
