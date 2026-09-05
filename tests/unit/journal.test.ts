import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/domain/money';
import { validateLegs, type LedgerLeg } from '../../src/services/ledger';
import * as journal from '../../src/services/journal';

const USD = 'asset-usd';
const BTC = 'asset-btc';
const ETH = 'asset-eth';
const USDC = 'asset-usdc';
const USER = 'user-1';

/** Signed net per asset. A template is correct only if every asset nets to zero. */
function netByAsset(legs: LedgerLeg[]): Map<string, Decimal> {
  const net = new Map<string, Decimal>();
  for (const leg of legs) {
    const amount = new Decimal(String(leg.amount));
    const signed = leg.direction === 'DEBIT' ? amount : amount.negated();
    net.set(leg.assetId, (net.get(leg.assetId) ?? new Decimal(0)).plus(signed));
  }
  return net;
}

function expectBalanced(template: journal.JournalTemplate): void {
  for (const [assetId, net] of netByAsset(template.legs)) {
    expect(`${assetId}=${net.toString()}`).toBe(`${assetId}=0`);
  }
  // Must also survive the ledger's own validation.
  expect(() => validateLegs(template.legs)).not.toThrow();
}

describe('journal templates', () => {
  describe('usdDeposit', () => {
    it('balances with a provider fee', () => {
      const t = journal.usdDeposit({
        userId: USER,
        usdAssetId: USD,
        grossAmount: '100',
        providerFee: '1',
      });
      expectBalanced(t);

      // The customer is credited net of the provider's cut.
      const userLeg = t.legs.find((l: LedgerLeg) => l.code === 'USER_FIAT');
      expect(String(userLeg?.amount)).toBe('99');

      // The fee is visible on both sides: paid away, and charged on.
      expect(t.legs.some((l: LedgerLeg) => l.code === 'PROVIDER_FEE_EXPENSE')).toBe(true);
      expect(t.legs.some((l: LedgerLeg) => l.code === 'FEE_REVENUE')).toBe(true);
    });

    it('balances with no provider fee, and emits no zero legs', () => {
      const t = journal.usdDeposit({
        userId: USER,
        usdAssetId: USD,
        grossAmount: '100',
        providerFee: '0',
      });
      expectBalanced(t);
      expect(t.legs).toHaveLength(2);
      expect(t.legs.every((l: LedgerLeg) => new Decimal(String(l.amount)).isPositive())).toBe(true);
    });

    it('credits the customer the full amount when the fee is zero', () => {
      const t = journal.usdDeposit({
        userId: USER,
        usdAssetId: USD,
        grossAmount: '250.75',
        providerFee: '0',
      });
      const userLeg = t.legs.find((l: LedgerLeg) => l.code === 'USER_FIAT');
      expect(String(userLeg?.amount)).toBe('250.75');
    });
  });

  describe('holds', () => {
    it('place and release are exact mirrors', () => {
      const place = journal.placeHold({
        userId: USER,
        assetId: USD,
        amount: '40',
        reason: 'WITHDRAWAL',
        isFiat: true,
      });
      const release = journal.releaseHold({
        userId: USER,
        assetId: USD,
        amount: '40',
        reason: 'WITHDRAWAL',
        isFiat: true,
      });
      expectBalanced(place);
      expectBalanced(release);

      // Same accounts, opposite directions.
      expect(place.legs.map((l: LedgerLeg) => l.code).sort()).toEqual(
        release.legs.map((l: LedgerLeg) => l.code).sort(),
      );
      for (const placed of place.legs) {
        const released = release.legs.find((l: LedgerLeg) => l.code === placed.code)!;
        expect(released.direction).not.toBe(placed.direction);
      }
    });

    it('holds crypto against the crypto balance', () => {
      const t = journal.placeHold({
        userId: USER,
        assetId: BTC,
        amount: '0.5',
        reason: 'ORDER',
        isFiat: false,
      });
      expectBalanced(t);
      expect(t.legs.some((l: LedgerLeg) => l.code === 'USER_CRYPTO' && l.direction === 'DEBIT')).toBe(true);
    });
  });

  describe('customerBuy', () => {
    it('balances a clean full fill', () => {
      const t = journal.customerBuy({
        userId: USER,
        usdAssetId: USD,
        cryptoAssetId: BTC,
        heldUsd: '100',
        brokerageFee: '1',
        cryptoDelivered: '0.00154687',
      });
      expectBalanced(t);

      // The customer is credited crypto and our USD equity rises by the net.
      const credited = t.legs.find(
        (l) => l.code === 'USER_CRYPTO' && l.direction === 'CREDIT',
      );
      expect(String(credited?.amount)).toBe('0.00154687');

      const proceeds = t.legs.find(
        (l) => l.code === 'TRADING_PL' && l.assetId === USD && l.direction === 'CREDIT',
      );
      expect(String(proceeds?.amount)).toBe('99');
    });

    it('does not touch the treasury account — the coins have not moved', () => {
      const t = journal.customerBuy({
        userId: USER,
        usdAssetId: USD,
        cryptoAssetId: BTC,
        heldUsd: '100',
        brokerageFee: '1',
        cryptoDelivered: '0.0015',
      });
      expect(t.legs.some((l: LedgerLeg) => l.code === 'TREASURY_HOT')).toBe(false);
    });

    it('returns the unfilled remainder to the customer', () => {
      const t = journal.customerBuy({
        userId: USER,
        usdAssetId: USD,
        cryptoAssetId: BTC,
        heldUsd: '100',
        brokerageFee: '0.6',
        cryptoDelivered: '0.00092812',
        refundedUsd: '39.4',
      });
      expectBalanced(t);

      const refund = t.legs.find((l: LedgerLeg) => l.code === 'USER_FIAT' && l.direction === 'CREDIT');
      expect(String(refund?.amount)).toBe('39.4');
    });

    it('refuses a fee plus refund that exceeds what was held', () => {
      expect(() =>
        journal.customerBuy({
          userId: USER,
          usdAssetId: USD,
          cryptoAssetId: BTC,
          heldUsd: '100',
          brokerageFee: '1',
          cryptoDelivered: '0.001',
          refundedUsd: '150',
        }),
      ).toThrow(/exceeds the/);
    });
  });

  describe('customerSell', () => {
    it('balances a full sale', () => {
      const t = journal.customerSell({
        userId: USER,
        usdAssetId: USD,
        cryptoAssetId: BTC,
        heldCrypto: '0.01',
        cryptoSold: '0.01',
        grossProceeds: '640',
        brokerageFee: '6.4',
        netProceeds: '633.6',
      });
      expectBalanced(t);
    });

    it('returns the unsold remainder to the crypto balance', () => {
      const t = journal.customerSell({
        userId: USER,
        usdAssetId: USD,
        cryptoAssetId: BTC,
        heldCrypto: '0.01',
        cryptoSold: '0.006',
        grossProceeds: '384',
        brokerageFee: '3.84',
        netProceeds: '380.16',
      });
      expectBalanced(t);

      const returned = t.legs.find((l: LedgerLeg) => l.code === 'USER_CRYPTO' && l.direction === 'CREDIT');
      expect(String(returned?.amount)).toBe('0.004');
    });

    it('routes a rounding residual rather than dropping it', () => {
      const t = journal.customerSell({
        userId: USER,
        usdAssetId: USD,
        cryptoAssetId: BTC,
        heldCrypto: '0.01',
        cryptoSold: '0.01',
        grossProceeds: '640.007',
        brokerageFee: '6.4',
        netProceeds: '633.6',
      });
      expectBalanced(t);
      expect(t.legs.some((l: LedgerLeg) => l.code === 'ROUNDING')).toBe(true);
    });

    it('refuses to sell more than was held', () => {
      expect(() =>
        journal.customerSell({
          userId: USER,
          usdAssetId: USD,
          cryptoAssetId: BTC,
          heldCrypto: '0.01',
          cryptoSold: '0.02',
          grossProceeds: '640',
          brokerageFee: '6.4',
          netProceeds: '633.6',
        }),
      ).toThrow(/more than was held/);
    });
  });

  describe('treasury sourcing', () => {
    it('balances a swap with gas', () => {
      const t = journal.treasurySwap({
        fromAssetId: USDC,
        toAssetId: BTC,
        amountIn: '99',
        amountOut: '0.00154687',
        gasAssetId: ETH,
        gasFee: '0.0008',
      });
      expectBalanced(t);
      expect(t.legs.some((l: LedgerLeg) => l.code === 'GAS_EXPENSE')).toBe(true);
    });

    it('balances a swap where the gas asset is also the output asset', () => {
      const t = journal.treasurySwap({
        fromAssetId: USDC,
        toAssetId: ETH,
        amountIn: '3200',
        amountOut: '1',
        gasAssetId: ETH,
        gasFee: '0.0008',
      });
      expectBalanced(t);
    });

    it('accounts for gas burned with no fill', () => {
      const t = journal.gasOnly({ gasAssetId: ETH, gasFee: '0.0008' });
      expectBalanced(t);
    });

    it('balances an OTC fill', () => {
      const t = journal.treasuryOtcFill({
        usdAssetId: USD,
        cryptoAssetId: BTC,
        usdCost: '10000',
        cryptoReceived: '0.15625',
        providerFee: '10',
      });
      expectBalanced(t);
    });

    it('balances a hot-to-cold transfer', () => {
      const t = journal.treasuryTransfer({
        assetId: BTC,
        amount: '1.5',
        direction: 'HOT_TO_COLD',
        gasAssetId: BTC,
        gasFee: '0.00005',
      });
      expectBalanced(t);
    });

    it('balances treasury funding', () => {
      expectBalanced(journal.treasuryFunding({ assetId: BTC, amount: '10' }));
      expectBalanced(journal.treasuryFunding({ assetId: BTC, amount: '10', tier: 'COLD' }));
    });
  });

  describe('cryptoWithdrawal', () => {
    it('balances with a network fee', () => {
      const t = journal.cryptoWithdrawal({
        userId: USER,
        cryptoAssetId: BTC,
        heldAmount: '0.01',
        networkFee: '0.00005',
        brokerageFee: '0.0001',
      });
      expectBalanced(t);
    });

    it('balances with no brokerage fee', () => {
      const t = journal.cryptoWithdrawal({
        userId: USER,
        cryptoAssetId: BTC,
        heldAmount: '0.01',
        networkFee: '0.00005',
        brokerageFee: '0',
      });
      expectBalanced(t);
    });
  });

  describe('usdWithdrawal', () => {
    it('balances with both fees', () => {
      const t = journal.usdWithdrawal({
        userId: USER,
        usdAssetId: USD,
        heldAmount: '100',
        brokerageFee: '1',
        providerFee: '0.5',
      });
      expectBalanced(t);
    });

    it('balances with no fees', () => {
      const t = journal.usdWithdrawal({
        userId: USER,
        usdAssetId: USD,
        heldAmount: '100',
        brokerageFee: '0',
        providerFee: '0',
      });
      expectBalanced(t);
    });
  });

  describe('corrections', () => {
    it('refunds from a hold', () => {
      expectBalanced(
        journal.refundToBalance({
          userId: USER,
          assetId: USD,
          amount: '25',
          isFiat: true,
          fromHold: true,
        }),
      );
    });

    it('adjusts in both directions', () => {
      expectBalanced(
        journal.manualAdjustment({
          userId: USER,
          assetId: USD,
          amount: '10',
          direction: 'CREDIT_CUSTOMER',
          isFiat: true,
          reason: 'Goodwill',
        }),
      );
      expectBalanced(
        journal.manualAdjustment({
          userId: USER,
          assetId: BTC,
          amount: '0.001',
          direction: 'DEBIT_CUSTOMER',
          isFiat: false,
          reason: 'Correcting an overcredit',
        }),
      );
    });

    it('deposits and settles crypto and USD', () => {
      expectBalanced(
        journal.cryptoDeposit({ userId: USER, cryptoAssetId: BTC, amount: '0.25' }),
      );
      expectBalanced(journal.usdSettlement({ usdAssetId: USD, amount: '5000' }));
    });
  });

  describe('property: no template can produce an unbalanced entry', () => {
    // A spread of awkward magnitudes: sub-cent, large, and high-precision.
    const amounts = ['0.01', '1', '99.99', '10000', '0.000000001', '123456.789'];

    it('usdDeposit balances across fee ratios', () => {
      for (const gross of amounts) {
        for (const feeRatio of ['0', '0.001', '0.01', '0.05']) {
          const fee = new Decimal(gross).times(feeRatio).toDecimalPlaces(18);
          expectBalanced(
            journal.usdDeposit({
              userId: USER,
              usdAssetId: USD,
              grossAmount: gross,
              providerFee: fee.toFixed(),
            }),
          );
        }
      }
    });

    it('customerBuy balances across fill ratios', () => {
      for (const held of ['10', '100', '9999.99']) {
        for (const fillRatio of ['1', '0.6', '0.01']) {
          const fee = new Decimal(held).times('0.01').toDecimalPlaces(2, Decimal.ROUND_UP);
          const spendable = new Decimal(held).minus(fee);
          const delivered = spendable
            .times(fillRatio)
            .dividedBy('64000')
            .toDecimalPlaces(8, Decimal.ROUND_DOWN);
          const chargedFee = fee.times(fillRatio).toDecimalPlaces(2, Decimal.ROUND_UP);
          const refund = spendable
            .times(new Decimal(1).minus(fillRatio))
            .toDecimalPlaces(2, Decimal.ROUND_DOWN)
            .plus(fee.minus(chargedFee));

          expectBalanced(
            journal.customerBuy({
              userId: USER,
              usdAssetId: USD,
              cryptoAssetId: BTC,
              heldUsd: held,
              brokerageFee: chargedFee.toFixed(),
              cryptoDelivered: delivered.toFixed(),
              refundedUsd: refund.toFixed(),
            }),
          );
        }
      }
    });

    it('customerSell balances across fill ratios', () => {
      for (const held of ['0.001', '0.5', '12.34567891']) {
        for (const fillRatio of ['1', '0.5', '0.1']) {
          const sold = new Decimal(held).times(fillRatio).toDecimalPlaces(18);
          const gross = sold.times('64000').toDecimalPlaces(18);
          const fee = gross.times('0.01').toDecimalPlaces(2, Decimal.ROUND_UP);
          const net = gross.minus(fee).toDecimalPlaces(2, Decimal.ROUND_DOWN);
          expectBalanced(
            journal.customerSell({
              userId: USER,
              usdAssetId: USD,
              cryptoAssetId: BTC,
              heldCrypto: held,
              cryptoSold: sold.toFixed(),
              grossProceeds: gross.toFixed(),
              brokerageFee: fee.toFixed(),
              netProceeds: net.toFixed(),
            }),
          );
        }
      }
    });

    it('treasurySwap balances across sizes and gas', () => {
      for (const amountIn of ['1', '1000', '250000.123456']) {
        for (const gas of ['0', '0.0008', '0.5']) {
          const out = new Decimal(amountIn).dividedBy('64000').toDecimalPlaces(18);
          expectBalanced(
            journal.treasurySwap({
              fromAssetId: USDC,
              toAssetId: BTC,
              amountIn,
              amountOut: out.toFixed(),
              gasAssetId: ETH,
              gasFee: gas,
            }),
          );
        }
      }
    });
  });
});
