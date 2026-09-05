import { Decimal, normalizeZero } from '../domain/money';
import { prisma } from '../server/db';
import { AuditAction, audit } from './audit';
import { AccountCode } from './accounts';

/**
 * Reconciliation.
 *
 * Three independent checks, each answering a different question:
 *   1. Do the balance projections match the entries?  (internal consistency)
 *   2. Does the whole ledger balance to zero per asset? (double-entry integrity)
 *   3. Are there business records stuck in a state that should have progressed?
 *      (operational health — a deposit confirmed but never credited, a provider
 *      call whose outcome we never learned)
 *
 * Nothing here mutates the ledger. Reconciliation reports; a human or a targeted
 * repair job decides what to do.
 */

export interface DriftRow {
  accountId: string;
  code: string;
  assetSymbol: string;
  ownerUserId: string | null;
  projected: string;
  computed: string;
  drift: string;
}

export interface StuckRecord {
  kind: 'DEPOSIT' | 'ORDER' | 'WITHDRAWAL' | 'PROVIDER_CALL';
  id: string;
  status: string;
  ageMinutes: number;
  detail: string;
}

export interface ReconciliationReport {
  ranAt: Date;
  accountsChecked: number;
  drift: DriftRow[];
  /** Signed total per asset across every account. Must be zero. */
  ledgerTotals: { assetSymbol: string; total: string; balanced: boolean }[];
  /** Customer liabilities vs assets we actually hold, per asset. */
  solvency: { assetSymbol: string; owedToCustomers: string; held: string; surplus: string }[];
  stuck: StuckRecord[];
  healthy: boolean;
}

/** Compare every projection against a recomputation from the entries. */
export async function findProjectionDrift(): Promise<DriftRow[]> {
  return prisma.$queryRaw<DriftRow[]>`
    SELECT la."id"          AS "accountId",
           la."code",
           a."symbol"       AS "assetSymbol",
           la."ownerUserId",
           COALESCE(bp."balance", 0)::text AS "projected",
           COALESCE(computed."balance", 0)::text AS "computed",
           (COALESCE(bp."balance", 0) - COALESCE(computed."balance", 0))::text AS "drift"
    FROM "ledger_accounts" la
    JOIN "assets" a ON a."id" = la."assetId"
    LEFT JOIN "balance_projections" bp ON bp."accountId" = la."id"
    LEFT JOIN LATERAL (
      SELECT SUM(CASE WHEN e."direction" = 'DEBIT' THEN e."amount" ELSE -e."amount" END) AS balance
      FROM "ledger_entries" e
      WHERE e."accountId" = la."id"
    ) computed ON TRUE
    WHERE COALESCE(bp."balance", 0) <> COALESCE(computed."balance", 0)
  `;
}

/**
 * The whole ledger, summed per asset. In a correct double-entry system this is
 * exactly zero. A non-zero value means entries were written outside the ledger
 * service, which the DB triggers should have made impossible.
 */
export async function checkLedgerTotals() {
  const rows = await prisma.$queryRaw<{ assetSymbol: string; total: string }[]>`
    SELECT a."symbol" AS "assetSymbol",
           COALESCE(SUM(CASE WHEN e."direction" = 'DEBIT' THEN e."amount" ELSE -e."amount" END), 0)::text AS total
    FROM "assets" a
    LEFT JOIN "ledger_entries" e ON e."assetId" = a."id"
    GROUP BY a."symbol"
    ORDER BY a."symbol"
  `;
  return rows.map((row) => ({
    assetSymbol: row.assetSymbol,
    total: row.total,
    balanced: new Decimal(row.total).isZero(),
  }));
}

/**
 * Solvency: what we owe customers versus what we hold for them.
 *
 * A negative surplus means customer liabilities exceed the assets backing them.
 * That is the single most serious condition this system can report.
 */
export async function checkSolvency() {
  const rows = await prisma.$queryRaw<
    { assetSymbol: string; owed: string; held: string }[]
  >`
    SELECT a."symbol" AS "assetSymbol",
           COALESCE(SUM(
             CASE WHEN la."code" IN (${AccountCode.USER_FIAT}, ${AccountCode.USER_CRYPTO},
                                     ${AccountCode.WITHDRAWAL_HOLD}, ${AccountCode.ORDER_HOLD})
             THEN -bp."balance" ELSE 0 END
           ), 0)::text AS owed,
           COALESCE(SUM(
             CASE WHEN la."code" IN (${AccountCode.VENUE_CUSTODY}, ${AccountCode.BANK_USD},
                                     ${AccountCode.PAYMENT_CLEARING},
                                     ${AccountCode.TREASURY_HOT}, ${AccountCode.TREASURY_COLD})
             THEN bp."balance" ELSE 0 END
           ), 0)::text AS held
    FROM "assets" a
    LEFT JOIN "ledger_accounts" la ON la."assetId" = a."id"
    LEFT JOIN "balance_projections" bp ON bp."accountId" = la."id"
    GROUP BY a."symbol"
    ORDER BY a."symbol"
  `;

  return rows.map((row) => {
    const owed = new Decimal(row.owed);
    const held = new Decimal(row.held);
    return {
      assetSymbol: row.assetSymbol,
      owedToCustomers: owed.toFixed(),
      held: held.toFixed(),
      surplus: normalizeZero(held.minus(owed)).toFixed(),
    };
  });
}

/** Business records that should have moved on by now. */
export async function findStuckRecords(staleMinutes = 15): Promise<StuckRecord[]> {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);
  const stuck: StuckRecord[] = [];
  const ageMinutes = (date: Date) => Math.round((Date.now() - date.getTime()) / 60_000);

  // Confirmed by the provider but never credited — a customer is owed money
  // that is not in their balance.
  const deposits = await prisma.deposit.findMany({
    where: { status: { in: ['CONFIRMED', 'AWAITING_PAYMENT'] }, createdAt: { lt: cutoff } },
    take: 100,
  });
  for (const deposit of deposits) {
    stuck.push({
      kind: 'DEPOSIT',
      id: deposit.id,
      status: deposit.status,
      ageMinutes: ageMinutes(deposit.createdAt),
      detail:
        deposit.status === 'CONFIRMED'
          ? 'Payment confirmed but not yet credited to the customer'
          : 'Awaiting customer payment',
    });
  }

  // Money is held but the order never resolved.
  const orders = await prisma.order.findMany({
    where: { status: { in: ['PAID', 'EXECUTING', 'PARTIALLY_FILLED'] }, createdAt: { lt: cutoff } },
    take: 100,
  });
  for (const order of orders) {
    stuck.push({
      kind: 'ORDER',
      id: order.id,
      status: order.status,
      ageMinutes: ageMinutes(order.createdAt),
      detail: 'Funds are held against an order that has not settled',
    });
  }

  const withdrawals = await prisma.withdrawal.findMany({
    where: { status: { in: ['CONFIRMED', 'SUBMITTED', 'BROADCAST'] }, createdAt: { lt: cutoff } },
    take: 100,
  });
  for (const withdrawal of withdrawals) {
    stuck.push({
      kind: 'WITHDRAWAL',
      id: withdrawal.id,
      status: withdrawal.status,
      ageMinutes: ageMinutes(withdrawal.createdAt),
      detail:
        withdrawal.status === 'CONFIRMED'
          ? 'Confirmed and held, but never submitted to the provider'
          : `Submitted with ${withdrawal.confirmations}/${withdrawal.requiredConfirmations} confirmations`,
    });
  }

  // Provider calls whose outcome we genuinely do not know. These are the
  // dangerous ones: the operation may have succeeded without us recording it.
  const calls = await prisma.providerTransaction.findMany({
    where: { status: { in: ['PENDING', 'UNKNOWN'] }, startedAt: { lt: cutoff } },
    take: 100,
  });
  for (const call of calls) {
    stuck.push({
      kind: 'PROVIDER_CALL',
      id: call.id,
      status: call.status,
      ageMinutes: ageMinutes(call.startedAt),
      detail: `${call.provider}.${call.operation} outcome unknown — query the provider before retrying`,
    });
  }

  return stuck;
}

export async function reconcile(
  options: { staleMinutes?: number } = {},
): Promise<ReconciliationReport> {
  const [drift, ledgerTotals, solvency, stuck, accountsChecked] = await Promise.all([
    findProjectionDrift(),
    checkLedgerTotals(),
    checkSolvency(),
    findStuckRecords(options.staleMinutes),
    prisma.ledgerAccount.count(),
  ]);

  const healthy =
    drift.length === 0 &&
    ledgerTotals.every((t) => t.balanced) &&
    solvency.every((s) => !new Decimal(s.surplus).isNegative());

  const report: ReconciliationReport = {
    ranAt: new Date(),
    accountsChecked,
    drift,
    ledgerTotals,
    solvency,
    stuck,
    healthy,
  };

  if (!healthy) {
    await audit(prisma, {
      actorType: 'SYSTEM',
      action: AuditAction.RECONCILIATION_DRIFT,
      entityType: 'Reconciliation',
      after: {
        driftCount: drift.length,
        unbalanced: ledgerTotals.filter((t) => !t.balanced).map((t) => t.assetSymbol),
        insolvent: solvency
          .filter((s) => new Decimal(s.surplus).isNegative())
          .map((s) => s.assetSymbol),
      },
    });
  }

  return report;
}

/**
 * Rebuild projections from the entries. The repair for drift — safe to run at
 * any time, because the entries are the source of truth and are immutable.
 */
export async function rebuildProjections(): Promise<number> {
  const result = await prisma.$executeRaw`
    INSERT INTO "balance_projections" ("id", "accountId", "balance", "entryCount", "lastEntryId", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text,
           la."id",
           COALESCE(SUM(CASE WHEN e."direction" = 'DEBIT' THEN e."amount" ELSE -e."amount" END), 0),
           COUNT(e."id")::int,
           MAX(e."id"),
           NOW(),
           NOW()
    FROM "ledger_accounts" la
    LEFT JOIN "ledger_entries" e ON e."accountId" = la."id"
    GROUP BY la."id"
    ON CONFLICT ("accountId") DO UPDATE
      SET "balance" = EXCLUDED."balance",
          "entryCount" = EXCLUDED."entryCount",
          "lastEntryId" = EXCLUDED."lastEntryId",
          "updatedAt" = NOW()
  `;
  return result;
}
