import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from '../../src/domain/money';
import { LedgerError } from '../../src/domain/errors';
import { AccountCode } from '../../src/services/accounts';
import {
  getAccountBalance,
  getUserBalances,
  postTransaction,
  recomputeAccountBalance,
} from '../../src/services/ledger';
import { prisma, createUser, getAsset, resetDatabase } from '../helpers';

describe('ledger', () => {
  let userId: string;
  let usdId: string;
  let btcId: string;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    userId = user.id;
    usdId = (await getAsset('USD')).id;
    btcId = (await getAsset('BTC')).id;
  });

  describe('balancing', () => {
    it('posts a balanced two-legged transaction', async () => {
      const tx = await postTransaction(prisma, {
        type: 'USD_DEPOSIT',
        referenceType: 'Deposit',
        referenceId: 'dep-1',
        idempotencyKey: 'ledger:dep-1',
        description: 'Test deposit',
        occurredAt: new Date(),
        legs: [
          { code: AccountCode.PAYMENT_CLEARING, assetId: usdId, direction: 'DEBIT', amount: '100' },
          {
            code: AccountCode.USER_FIAT,
            assetId: usdId,
            userId,
            direction: 'CREDIT',
            amount: '100',
          },
        ],
      });

      expect(tx.entries).toHaveLength(2);

      // The customer is owed $100 — a liability, so the signed balance is negative
      // and the natural balance is positive.
      const balance = await getAccountBalance(prisma, {
        code: AccountCode.USER_FIAT,
        assetId: usdId,
        userId,
      });
      expect(balance.natural.toString()).toBe('100');
      expect(balance.signed.toString()).toBe('-100');
    });

    it('rejects a transaction whose legs do not sum to zero', async () => {
      await expect(
        postTransaction(prisma, {
          type: 'ADJUSTMENT',
          referenceType: 'Test',
          referenceId: 'unbalanced',
          idempotencyKey: 'ledger:unbalanced',
          description: 'Unbalanced',
          occurredAt: new Date(),
          legs: [
            { code: AccountCode.BANK_USD, assetId: usdId, direction: 'DEBIT', amount: '100' },
            {
              code: AccountCode.USER_FIAT,
              assetId: usdId,
              userId,
              direction: 'CREDIT',
              amount: '99',
            },
          ],
        }),
      ).rejects.toThrow(LedgerError);

      // Nothing was persisted.
      expect(await prisma.ledgerTransaction.count()).toBe(0);
      expect(await prisma.ledgerEntry.count()).toBe(0);
    });

    it('rejects a single-legged transaction', async () => {
      await expect(
        postTransaction(prisma, {
          type: 'ADJUSTMENT',
          referenceType: 'Test',
          referenceId: 'single',
          idempotencyKey: 'ledger:single',
          description: 'Single leg',
          occurredAt: new Date(),
          legs: [
            { code: AccountCode.BANK_USD, assetId: usdId, direction: 'DEBIT', amount: '100' },
          ],
        }),
      ).rejects.toThrow(LedgerError);
    });

    it('rejects non-positive amounts', async () => {
      await expect(
        postTransaction(prisma, {
          type: 'ADJUSTMENT',
          referenceType: 'Test',
          referenceId: 'zero',
          idempotencyKey: 'ledger:zero',
          description: 'Zero leg',
          occurredAt: new Date(),
          legs: [
            { code: AccountCode.BANK_USD, assetId: usdId, direction: 'DEBIT', amount: '0' },
            { code: AccountCode.USER_FIAT, assetId: usdId, userId, direction: 'CREDIT', amount: '0' },
          ],
        }),
      ).rejects.toThrow(LedgerError);
    });

    it('balances each asset independently in a multi-asset transaction', async () => {
      await postTransaction(prisma, {
        type: 'CRYPTO_PURCHASE',
        referenceType: 'Order',
        referenceId: 'ord-1',
        idempotencyKey: 'ledger:ord-1',
        description: 'Buy BTC',
        occurredAt: new Date(),
        legs: [
          { code: AccountCode.USER_FIAT, assetId: usdId, userId, direction: 'DEBIT', amount: '100' },
          { code: AccountCode.BANK_USD, assetId: usdId, direction: 'CREDIT', amount: '100' },
          { code: AccountCode.VENUE_CUSTODY, assetId: btcId, direction: 'DEBIT', amount: '0.002' },
          {
            code: AccountCode.USER_CRYPTO,
            assetId: btcId,
            userId,
            direction: 'CREDIT',
            amount: '0.002',
          },
        ],
      });

      const btc = await getAccountBalance(prisma, {
        code: AccountCode.USER_CRYPTO,
        assetId: btcId,
        userId,
      });
      expect(btc.natural.toString()).toBe('0.002');
    });

    it('rejects a multi-asset transaction where only the total balances', async () => {
      await expect(
        postTransaction(prisma, {
          type: 'ADJUSTMENT',
          referenceType: 'Test',
          referenceId: 'cross-asset',
          idempotencyKey: 'ledger:cross-asset',
          description: 'USD debit paired with a BTC credit',
          occurredAt: new Date(),
          legs: [
            { code: AccountCode.BANK_USD, assetId: usdId, direction: 'DEBIT', amount: '100' },
            {
              code: AccountCode.USER_CRYPTO,
              assetId: btcId,
              userId,
              direction: 'CREDIT',
              amount: '100',
            },
          ],
        }),
      ).rejects.toThrow(LedgerError);
    });
  });

  describe('immutability', () => {
    it('refuses UPDATE of a posted entry', async () => {
      await postTransaction(prisma, {
        type: 'USD_DEPOSIT',
        referenceType: 'Deposit',
        referenceId: 'dep-2',
        idempotencyKey: 'ledger:dep-2',
        description: 'Test',
        occurredAt: new Date(),
        legs: [
          { code: AccountCode.PAYMENT_CLEARING, assetId: usdId, direction: 'DEBIT', amount: '50' },
          { code: AccountCode.USER_FIAT, assetId: usdId, userId, direction: 'CREDIT', amount: '50' },
        ],
      });

      const entry = await prisma.ledgerEntry.findFirstOrThrow();
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "ledger_entries" SET "amount" = 999 WHERE "id" = '${entry.id}'`,
        ),
      ).rejects.toThrow(/append-only/i);
    });

    it('refuses DELETE of a posted entry', async () => {
      await postTransaction(prisma, {
        type: 'USD_DEPOSIT',
        referenceType: 'Deposit',
        referenceId: 'dep-3',
        idempotencyKey: 'ledger:dep-3',
        description: 'Test',
        occurredAt: new Date(),
        legs: [
          { code: AccountCode.PAYMENT_CLEARING, assetId: usdId, direction: 'DEBIT', amount: '50' },
          { code: AccountCode.USER_FIAT, assetId: usdId, userId, direction: 'CREDIT', amount: '50' },
        ],
      });

      const entry = await prisma.ledgerEntry.findFirstOrThrow();
      await expect(
        prisma.$executeRawUnsafe(`DELETE FROM "ledger_entries" WHERE "id" = '${entry.id}'`),
      ).rejects.toThrow(/append-only/i);
    });
  });

  describe('idempotency', () => {
    it('posts once when the same idempotency key is used twice', async () => {
      const input = {
        type: 'USD_DEPOSIT' as const,
        referenceType: 'Deposit',
        referenceId: 'dep-4',
        idempotencyKey: 'ledger:dep-4',
        description: 'Duplicate deposit attempt',
        occurredAt: new Date(),
        legs: [
          {
            code: AccountCode.PAYMENT_CLEARING,
            assetId: usdId,
            direction: 'DEBIT' as const,
            amount: '75',
          },
          {
            code: AccountCode.USER_FIAT,
            assetId: usdId,
            userId,
            direction: 'CREDIT' as const,
            amount: '75',
          },
        ],
      };

      const first = await postTransaction(prisma, input);
      const second = await postTransaction(prisma, input);

      expect(second.id).toBe(first.id);
      expect(await prisma.ledgerTransaction.count()).toBe(1);
      expect(await prisma.ledgerEntry.count()).toBe(2);

      const balance = await getAccountBalance(prisma, {
        code: AccountCode.USER_FIAT,
        assetId: usdId,
        userId,
      });
      expect(balance.natural.toString()).toBe('75');
    });

    it('posts concurrent duplicates exactly once', async () => {
      const input = {
        type: 'USD_DEPOSIT' as const,
        referenceType: 'Deposit',
        referenceId: 'dep-5',
        idempotencyKey: 'ledger:dep-5',
        description: 'Concurrent duplicate',
        occurredAt: new Date(),
        legs: [
          {
            code: AccountCode.PAYMENT_CLEARING,
            assetId: usdId,
            direction: 'DEBIT' as const,
            amount: '10',
          },
          {
            code: AccountCode.USER_FIAT,
            assetId: usdId,
            userId,
            direction: 'CREDIT' as const,
            amount: '10',
          },
        ],
      };

      const results = await Promise.allSettled([
        postTransaction(prisma, input),
        postTransaction(prisma, input),
        postTransaction(prisma, input),
      ]);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

      expect(await prisma.ledgerTransaction.count()).toBe(1);
      const balance = await getAccountBalance(prisma, {
        code: AccountCode.USER_FIAT,
        assetId: usdId,
        userId,
      });
      expect(balance.natural.toString()).toBe('10');
    });
  });

  describe('projections', () => {
    it('keeps the projection equal to the recomputed balance', async () => {
      for (let i = 0; i < 5; i += 1) {
        await postTransaction(prisma, {
          type: 'USD_DEPOSIT',
          referenceType: 'Deposit',
          referenceId: `dep-p${i}`,
          idempotencyKey: `ledger:dep-p${i}`,
          description: 'Projection test',
          occurredAt: new Date(),
          legs: [
            {
              code: AccountCode.PAYMENT_CLEARING,
              assetId: usdId,
              direction: 'DEBIT',
              amount: '20.55',
            },
            {
              code: AccountCode.USER_FIAT,
              assetId: usdId,
              userId,
              direction: 'CREDIT',
              amount: '20.55',
            },
          ],
        });
      }

      const projected = await getAccountBalance(prisma, {
        code: AccountCode.USER_FIAT,
        assetId: usdId,
        userId,
      });
      const recomputed = await recomputeAccountBalance(prisma, projected.accountId);

      expect(projected.signed.toString()).toBe(recomputed.toString());
      expect(projected.natural.toString()).toBe('102.75');
    });

    it('reports every asset balance a customer holds', async () => {
      await postTransaction(prisma, {
        type: 'CRYPTO_PURCHASE',
        referenceType: 'Order',
        referenceId: 'ord-2',
        idempotencyKey: 'ledger:ord-2',
        description: 'Buy',
        occurredAt: new Date(),
        legs: [
          { code: AccountCode.BANK_USD, assetId: usdId, direction: 'DEBIT', amount: '100' },
          { code: AccountCode.USER_FIAT, assetId: usdId, userId, direction: 'CREDIT', amount: '100' },
          { code: AccountCode.VENUE_CUSTODY, assetId: btcId, direction: 'DEBIT', amount: '0.5' },
          {
            code: AccountCode.USER_CRYPTO,
            assetId: btcId,
            userId,
            direction: 'CREDIT',
            amount: '0.5',
          },
        ],
      });

      const balances = await getUserBalances(prisma, userId);
      const usd = balances.find((b) => b.symbol === 'USD');
      const btc = balances.find((b) => b.symbol === 'BTC');

      expect(usd?.available.toString()).toBe('100');
      expect(btc?.available.toString()).toBe('0.5');
    });

    it('excludes held funds from the available balance', async () => {
      await postTransaction(prisma, {
        type: 'USD_DEPOSIT',
        referenceType: 'Deposit',
        referenceId: 'dep-6',
        idempotencyKey: 'ledger:dep-6',
        description: 'Fund',
        occurredAt: new Date(),
        legs: [
          { code: AccountCode.PAYMENT_CLEARING, assetId: usdId, direction: 'DEBIT', amount: '100' },
          { code: AccountCode.USER_FIAT, assetId: usdId, userId, direction: 'CREDIT', amount: '100' },
        ],
      });

      await postTransaction(prisma, {
        type: 'WITHDRAWAL_HOLD',
        referenceType: 'Withdrawal',
        referenceId: 'wd-1',
        idempotencyKey: 'ledger:wd-1-hold',
        description: 'Hold for withdrawal',
        occurredAt: new Date(),
        legs: [
          { code: AccountCode.USER_FIAT, assetId: usdId, userId, direction: 'DEBIT', amount: '40' },
          {
            code: AccountCode.WITHDRAWAL_HOLD,
            assetId: usdId,
            userId,
            direction: 'CREDIT',
            amount: '40',
          },
        ],
      });

      const balances = await getUserBalances(prisma, userId);
      const usd = balances.find((b) => b.symbol === 'USD');

      expect(usd?.available.toString()).toBe('60');
      expect(usd?.held.toString()).toBe('40');
      expect(usd?.total.toString()).toBe('100');
    });
  });

  describe('reversals', () => {
    it('reverses a transaction by posting mirrored entries, leaving the original intact', async () => {
      const original = await postTransaction(prisma, {
        type: 'USD_DEPOSIT',
        referenceType: 'Deposit',
        referenceId: 'dep-7',
        idempotencyKey: 'ledger:dep-7',
        description: 'Deposit to reverse',
        occurredAt: new Date(),
        legs: [
          { code: AccountCode.PAYMENT_CLEARING, assetId: usdId, direction: 'DEBIT', amount: '100' },
          { code: AccountCode.USER_FIAT, assetId: usdId, userId, direction: 'CREDIT', amount: '100' },
        ],
      });

      const { reverseTransaction } = await import('../../src/services/ledger');
      await reverseTransaction(prisma, {
        transactionId: original.id,
        idempotencyKey: 'ledger:dep-7:reversal',
        reason: 'Payment charged back',
      });

      const balance = await getAccountBalance(prisma, {
        code: AccountCode.USER_FIAT,
        assetId: usdId,
        userId,
      });
      expect(balance.natural.toString()).toBe('0');

      // Both the original and the reversal remain on the record.
      expect(await prisma.ledgerTransaction.count()).toBe(2);
      expect(await prisma.ledgerEntry.count()).toBe(4);
    });

    it('reverses only once for a repeated reversal request', async () => {
      const original = await postTransaction(prisma, {
        type: 'USD_DEPOSIT',
        referenceType: 'Deposit',
        referenceId: 'dep-8',
        idempotencyKey: 'ledger:dep-8',
        description: 'Deposit',
        occurredAt: new Date(),
        legs: [
          { code: AccountCode.PAYMENT_CLEARING, assetId: usdId, direction: 'DEBIT', amount: '30' },
          { code: AccountCode.USER_FIAT, assetId: usdId, userId, direction: 'CREDIT', amount: '30' },
        ],
      });

      const { reverseTransaction } = await import('../../src/services/ledger');
      const args = {
        transactionId: original.id,
        idempotencyKey: 'ledger:dep-8:reversal',
        reason: 'Duplicate',
      };
      await reverseTransaction(prisma, args);
      await reverseTransaction(prisma, args);

      expect(await prisma.ledgerTransaction.count()).toBe(2);
      const balance = await getAccountBalance(prisma, {
        code: AccountCode.USER_FIAT,
        assetId: usdId,
        userId,
      });
      expect(balance.natural.toString()).toBe('0');
    });
  });

  describe('precision', () => {
    it('preserves 18 decimal places without drift', async () => {
      const tiny = '0.000000000000000001';
      await postTransaction(prisma, {
        type: 'CRYPTO_DEPOSIT',
        referenceType: 'Test',
        referenceId: 'precision',
        idempotencyKey: 'ledger:precision',
        description: 'Smallest representable amount',
        occurredAt: new Date(),
        legs: [
          { code: AccountCode.VENUE_CUSTODY, assetId: btcId, direction: 'DEBIT', amount: tiny },
          {
            code: AccountCode.USER_CRYPTO,
            assetId: btcId,
            userId,
            direction: 'CREDIT',
            amount: tiny,
          },
        ],
      });

      const balance = await getAccountBalance(prisma, {
        code: AccountCode.USER_CRYPTO,
        assetId: btcId,
        userId,
      });
      expect(balance.natural.eq(new Decimal(tiny))).toBe(true);
    });

    it('refuses an amount with more precision than the ledger stores', async () => {
      await expect(
        postTransaction(prisma, {
          type: 'ADJUSTMENT',
          referenceType: 'Test',
          referenceId: 'too-precise',
          idempotencyKey: 'ledger:too-precise',
          description: 'Nineteen decimal places',
          occurredAt: new Date(),
          legs: [
            {
              code: AccountCode.VENUE_CUSTODY,
              assetId: btcId,
              direction: 'DEBIT',
              amount: '0.0000000000000000001',
            },
            {
              code: AccountCode.USER_CRYPTO,
              assetId: btcId,
              userId,
              direction: 'CREDIT',
              amount: '0.0000000000000000001',
            },
          ],
        }),
      ).rejects.toThrow();
    });
  });
});
