import { Decimal } from '../domain/money';
import { prisma } from '../server/db';

/**
 * Unified transaction history.
 *
 * Built from the ledger rather than from the business tables, so what the
 * customer sees is exactly what the books say happened. A record that never
 * produced ledger entries never moved money, and correctly does not appear.
 */

export interface HistoryEntry {
  id: string;
  type: string;
  description: string;
  occurredAt: string;
  referenceType: string;
  referenceId: string;
  /** The customer-visible effect, per asset. Positive is money in. */
  changes: { symbol: string; amount: string; quoteScale: number }[];
}

export async function getTransactionHistory(
  userId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<HistoryEntry[]> {
  const limit = Math.min(options.limit ?? 50, 200);

  const rows = await prisma.$queryRaw<
    {
      transactionId: string;
      type: string;
      description: string;
      occurredAt: Date;
      referenceType: string;
      referenceId: string;
      symbol: string;
      quoteScale: number;
      code: string;
      signed: string;
    }[]
  >`
    SELECT lt."id"            AS "transactionId",
           lt."type"::text    AS "type",
           lt."description",
           lt."occurredAt",
           lt."referenceType",
           lt."referenceId",
           a."symbol",
           a."quoteScale",
           la."code",
           SUM(CASE WHEN e."direction" = 'DEBIT' THEN e."amount" ELSE -e."amount" END)::text AS "signed"
    FROM "ledger_transactions" lt
    JOIN "ledger_entries" e ON e."transactionId" = lt."id"
    JOIN "ledger_accounts" la ON la."id" = e."accountId"
    JOIN "assets" a ON a."id" = e."assetId"
    WHERE la."ownerUserId" = ${userId}
    GROUP BY lt."id", lt."type", lt."description", lt."occurredAt",
             lt."referenceType", lt."referenceId", a."symbol", a."quoteScale", la."code"
    ORDER BY lt."occurredAt" DESC, lt."id" DESC
    LIMIT ${limit * 6}
  `;

  const byTransaction = new Map<string, HistoryEntry>();
  const amounts = new Map<string, Map<string, { amount: Decimal; quoteScale: number }>>();

  for (const row of rows) {
    if (!byTransaction.has(row.transactionId)) {
      byTransaction.set(row.transactionId, {
        id: row.transactionId,
        type: row.type,
        description: row.description,
        occurredAt: row.occurredAt.toISOString(),
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        changes: [],
      });
      amounts.set(row.transactionId, new Map());
    }

    // These are all liability accounts, so a CREDIT (negative signed) means the
    // customer gained. Flip the sign to get the customer's own perspective.
    const delta = new Decimal(row.signed).negated();
    const perAsset = amounts.get(row.transactionId)!;
    const current = perAsset.get(row.symbol);
    perAsset.set(row.symbol, {
      amount: (current?.amount ?? new Decimal(0)).plus(delta),
      quoteScale: row.quoteScale,
    });
  }

  const entries: HistoryEntry[] = [];
  for (const [transactionId, entry] of byTransaction) {
    const perAsset = amounts.get(transactionId)!;
    entry.changes = [...perAsset.entries()]
      // A hold moves money between two of the customer's own accounts and nets
      // to zero; showing it as a transaction would just confuse.
      .filter(([, value]) => !value.amount.isZero())
      .map(([symbol, value]) => ({
        symbol,
        amount: value.amount.toFixed(value.quoteScale),
        quoteScale: value.quoteScale,
      }));

    if (entry.changes.length > 0) entries.push(entry);
  }

  return entries.slice(0, limit);
}
