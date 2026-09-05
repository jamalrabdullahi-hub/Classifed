import type { LedgerDirection, LedgerTransactionType, Prisma } from '@prisma/client';
import { Decimal, normalizeZero, toDbDecimal, type Numeric } from '../domain/money';
import { LedgerError } from '../domain/errors';
import { newId } from '../domain/id';
import { isUniqueViolation, prisma as defaultDb, type DbClient } from '../server/db';
import {
  AccountCode,
  isNaturallyCredit,
  resolveAccount,
  type AccountCodeValue,
} from './accounts';

/**
 * The ledger. Every financial event in the system ends up here, and nothing
 * else is allowed to write to the ledger tables.
 *
 * Two rules, enforced both here and by database triggers:
 *   1. A transaction balances to zero per asset.
 *   2. Nothing is ever updated or deleted. Corrections are reversing entries.
 */

export interface LedgerLeg {
  code: AccountCodeValue;
  assetId: string;
  /** Required for per-customer accounts, forbidden for system accounts. */
  userId?: string | null;
  direction: LedgerDirection;
  amount: Numeric;
}

export interface PostTransactionInput {
  type: LedgerTransactionType;
  referenceType: string;
  referenceId: string;
  /**
   * Uniquely names this business event. A second attempt to post the same event
   * returns the original transaction instead of double-posting.
   */
  idempotencyKey: string;
  description: string;
  occurredAt: Date;
  metadata?: Prisma.InputJsonValue;
  legs: LedgerLeg[];
}

export interface PostedTransaction {
  id: string;
  idempotencyKey: string;
  entries: { id: string; accountId: string; direction: LedgerDirection; amount: Decimal }[];
  /** True when this call found an existing transaction rather than creating one. */
  deduplicated: boolean;
}

/** Signed sum of a set of legs, per asset. DEBIT positive, CREDIT negative. */
function netByAsset(legs: { assetId: string; direction: LedgerDirection; amount: Decimal }[]) {
  const net = new Map<string, Decimal>();
  for (const leg of legs) {
    const signed = leg.direction === 'DEBIT' ? leg.amount : leg.amount.negated();
    net.set(leg.assetId, (net.get(leg.assetId) ?? new Decimal(0)).plus(signed));
  }
  return net;
}

/**
 * Validate the journal entry before it touches the database. The DB triggers are
 * the backstop; this is where a caller gets a message they can act on.
 */
export type NormalizedLeg = Omit<LedgerLeg, 'amount'> & { amount: Decimal };

export function validateLegs(legs: LedgerLeg[]): NormalizedLeg[] {
  if (legs.length < 2) {
    throw new LedgerError('A ledger transaction requires at least two legs', {
      legCount: legs.length,
    });
  }

  const normalized = legs.map((leg, index) => {
    let amount: Decimal;
    try {
      amount = toDbDecimal(leg.amount);
    } catch (error) {
      throw new LedgerError(
        `Leg ${index} (${leg.code}) has an unusable amount: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!amount.isPositive() || amount.isZero()) {
      throw new LedgerError(
        `Leg ${index} (${leg.code}) must be strictly positive; direction carries the sign`,
        { amount: amount.toString() },
      );
    }
    return { ...leg, amount };
  });

  for (const [assetId, net] of netByAsset(normalized)) {
    if (!net.isZero()) {
      throw new LedgerError(
        `Ledger transaction does not balance for asset ${assetId}: net ${net.toString()}`,
        { assetId, net: net.toString() },
      );
    }
  }

  return normalized;
}

/**
 * Post a journal entry and update the affected balance projections, atomically.
 *
 * Safe to call inside a caller-supplied transaction (pass `db`), which is how
 * order execution keeps its ledger postings in the same unit of work as the
 * order status change.
 */
export async function postTransaction(
  db: DbClient,
  input: PostTransactionInput,
): Promise<PostedTransaction> {
  const legs = validateLegs(input.legs);

  const existing = await db.ledgerTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { entries: true },
  });
  if (existing) {
    return {
      id: existing.id,
      idempotencyKey: existing.idempotencyKey,
      entries: existing.entries.map((e) => ({
        id: e.id,
        accountId: e.accountId,
        direction: e.direction,
        amount: new Decimal(e.amount.toString()),
      })),
      deduplicated: true,
    };
  }

  // Resolve (creating if needed) every account this entry touches.
  const resolved = await Promise.all(
    legs.map(async (leg) => ({
      leg,
      account: await resolveAccount(db, {
        code: leg.code,
        assetId: leg.assetId,
        userId: leg.userId ?? null,
      }),
    })),
  );

  const transactionId = newId();

  try {
    await db.ledgerTransaction.create({
      data: {
        id: transactionId,
        type: input.type,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        idempotencyKey: input.idempotencyKey,
        description: input.description,
        metadata: input.metadata ?? undefined,
        occurredAt: input.occurredAt,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error, 'idempotencyKey')) {
      // Another writer posted this same event concurrently. Theirs stands.
      return postTransaction(db, input);
    }
    throw error;
  }

  const entryRows = resolved.map(({ leg, account }) => ({
    id: newId(),
    transactionId,
    accountId: account.id,
    assetId: leg.assetId,
    direction: leg.direction,
    amount: leg.amount.toFixed(),
  }));

  await db.ledgerEntry.createMany({ data: entryRows });

  // Projections are a cache of the entries, maintained in the same transaction
  // so a reader never sees entries without the balance that reflects them.
  await updateProjections(db, resolved, entryRows);

  return {
    id: transactionId,
    idempotencyKey: input.idempotencyKey,
    entries: entryRows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      direction: row.direction,
      amount: new Decimal(row.amount),
    })),
    deduplicated: false,
  };
}

async function updateProjections(
  db: DbClient,
  resolved: { leg: { direction: LedgerDirection; amount: Decimal }; account: { id: string } }[],
  entryRows: { id: string; accountId: string }[],
): Promise<void> {
  const deltas = new Map<string, { delta: Decimal; count: number; lastEntryId: string }>();

  resolved.forEach(({ leg, account }, index) => {
    const signed = leg.direction === 'DEBIT' ? leg.amount : leg.amount.negated();
    const current = deltas.get(account.id);
    deltas.set(account.id, {
      delta: (current?.delta ?? new Decimal(0)).plus(signed),
      count: (current?.count ?? 0) + 1,
      lastEntryId: entryRows[index]!.id,
    });
  });

  for (const [accountId, { delta, count, lastEntryId }] of deltas) {
    // Upsert-with-increment in one statement, so concurrent postings to the same
    // account accumulate rather than clobber.
    await db.$executeRaw`
      INSERT INTO "balance_projections" ("id", "accountId", "balance", "entryCount", "lastEntryId", "createdAt", "updatedAt")
      VALUES (${newId()}, ${accountId}, ${delta.toFixed()}::numeric, ${count}, ${lastEntryId}, NOW(), NOW())
      ON CONFLICT ("accountId") DO UPDATE
        SET "balance" = "balance_projections"."balance" + ${delta.toFixed()}::numeric,
            "entryCount" = "balance_projections"."entryCount" + ${count},
            "lastEntryId" = ${lastEntryId},
            "updatedAt" = NOW()
    `;
  }
}

/**
 * Post the exact mirror of an existing transaction. The original is untouched —
 * this is how the ledger corrects itself without ever rewriting history.
 */
export async function reverseTransaction(
  db: DbClient,
  input: { transactionId: string; idempotencyKey: string; reason: string; occurredAt?: Date },
): Promise<PostedTransaction> {
  const original = await db.ledgerTransaction.findUnique({
    where: { id: input.transactionId },
    include: { entries: { include: { account: true } } },
  });
  if (!original) {
    throw new LedgerError(`Cannot reverse unknown transaction ${input.transactionId}`);
  }

  const legs: LedgerLeg[] = original.entries.map((entry) => ({
    code: entry.account.code as AccountCodeValue,
    assetId: entry.assetId,
    userId: entry.account.ownerUserId,
    direction: entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
    amount: new Decimal(entry.amount.toString()),
  }));

  return postTransaction(db, {
    type: 'REVERSAL',
    referenceType: 'LedgerTransaction',
    referenceId: original.id,
    idempotencyKey: input.idempotencyKey,
    description: `Reversal of ${original.description}: ${input.reason}`,
    occurredAt: input.occurredAt ?? new Date(),
    metadata: { reversedTransactionId: original.id, reason: input.reason },
    legs,
  });
}

// ---------------------------------------------------------------------------
// Reading balances
// ---------------------------------------------------------------------------

export interface AccountBalance {
  accountId: string;
  code: string;
  assetId: string;
  /** DEBIT-positive. What the ledger literally holds. */
  signed: Decimal;
  /** Sign-corrected for the account kind. What a human means by "balance". */
  natural: Decimal;
}

export async function getAccountBalance(
  db: DbClient,
  params: { code: AccountCodeValue; assetId: string; userId?: string | null },
): Promise<AccountBalance> {
  const account = await resolveAccount(db, params);
  const projection = await db.balanceProjection.findUnique({
    where: { accountId: account.id },
  });

  const signed = normalizeZero(new Decimal(projection?.balance?.toString() ?? '0'));
  return {
    accountId: account.id,
    code: account.code,
    assetId: account.assetId,
    signed,
    natural: normalizeZero(isNaturallyCredit(account.kind) ? signed.negated() : signed),
  };
}

/**
 * Recompute an account's balance from the entries alone. This — not the
 * projection — is the definition of correct. The reconciler compares the two.
 */
export async function recomputeAccountBalance(
  db: DbClient,
  accountId: string,
): Promise<Decimal> {
  const rows = await db.$queryRaw<{ balance: string | null }[]>`
    SELECT COALESCE(
      SUM(CASE WHEN "direction" = 'DEBIT' THEN "amount" ELSE -"amount" END), 0
    )::text AS balance
    FROM "ledger_entries"
    WHERE "accountId" = ${accountId}
  `;
  return new Decimal(rows[0]?.balance ?? '0');
}

export interface UserAssetBalance {
  assetId: string;
  symbol: string;
  name: string;
  kind: 'FIAT' | 'CRYPTO';
  quoteScale: number;
  /** Spendable right now. */
  available: Decimal;
  /** Earmarked for an in-flight withdrawal or order. */
  held: Decimal;
  total: Decimal;
}

/**
 * Every balance a customer holds, derived from ledger projections.
 *
 * "Available" deliberately excludes held funds: money committed to a pending
 * withdrawal or an executing order must not be spendable a second time.
 */
export async function getUserBalances(
  db: DbClient,
  userId: string,
): Promise<UserAssetBalance[]> {
  const rows = await db.$queryRaw<
    {
      assetId: string;
      symbol: string;
      name: string;
      kind: 'FIAT' | 'CRYPTO';
      quoteScale: number;
      code: string;
      balance: string | null;
    }[]
  >`
    SELECT a."id"         AS "assetId",
           a."symbol",
           a."name",
           a."kind"::text AS "kind",
           a."quoteScale",
           la."code",
           bp."balance"::text AS "balance"
    FROM "assets" a
    LEFT JOIN "ledger_accounts" la
      ON la."assetId" = a."id"
     AND la."ownerUserId" = ${userId}
     AND la."code" IN (${AccountCode.USER_FIAT}, ${AccountCode.USER_CRYPTO},
                       ${AccountCode.WITHDRAWAL_HOLD}, ${AccountCode.ORDER_HOLD})
    LEFT JOIN "balance_projections" bp ON bp."accountId" = la."id"
    WHERE a."isActive" = true
    ORDER BY a."sortOrder"
  `;

  const byAsset = new Map<string, UserAssetBalance>();

  for (const row of rows) {
    let entry = byAsset.get(row.assetId);
    if (!entry) {
      entry = {
        assetId: row.assetId,
        symbol: row.symbol,
        name: row.name,
        kind: row.kind,
        quoteScale: row.quoteScale,
        available: new Decimal(0),
        held: new Decimal(0),
        total: new Decimal(0),
      };
      byAsset.set(row.assetId, entry);
    }

    if (!row.code || row.balance === null) continue;
    // These are all LIABILITY accounts, so natural balance is the negated signed.
    const natural = normalizeZero(new Decimal(row.balance).negated());

    if (row.code === AccountCode.USER_FIAT || row.code === AccountCode.USER_CRYPTO) {
      entry.available = entry.available.plus(natural);
    } else {
      entry.held = entry.held.plus(natural);
    }
  }

  for (const entry of byAsset.values()) {
    entry.available = normalizeZero(entry.available);
    entry.held = normalizeZero(entry.held);
    entry.total = normalizeZero(entry.available.plus(entry.held));
  }

  return [...byAsset.values()];
}

/** Convenience for the common "can this customer afford it?" check. */
export async function getAvailableBalance(
  db: DbClient,
  params: { userId: string; assetId: string; isFiat: boolean },
): Promise<Decimal> {
  const balance = await getAccountBalance(db, {
    code: params.isFiat ? AccountCode.USER_FIAT : AccountCode.USER_CRYPTO,
    assetId: params.assetId,
    userId: params.userId,
  });
  return balance.natural;
}

export { defaultDb as ledgerDb };
