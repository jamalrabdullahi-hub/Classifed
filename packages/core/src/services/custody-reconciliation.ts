import { LedgerAccountKind, prisma } from '@flt/db';
import { Decimal } from '../domain/money';
import type { CustodyBalance } from '../ports';

/**
 * Reconciliation: does what FLT holds match what FLT owes?
 *
 * The one control that makes a custodial ledger a record of solvency rather
 * than a promise. `docs/adr/0004-custodial-omnibus.md` makes it mandatory: the
 * total the ledger says is owed to clients must never exceed what the omnibus
 * actually holds.
 *
 * ## It compares; it never corrects
 *
 * Every function here reads. None writes a ledger balance to match the chain —
 * that would cancel the only check that proves the ledger is backed, and is
 * precisely the shortcut that let FTX quote a balance nothing stood behind. A
 * divergence is the finding, not something to paper over.
 *
 * ## Two questions, in order
 *
 *   1. Does the ledger agree with itself? `ledgerIntegrityReport` re-derives
 *      each account from its entries and compares against the cached balance.
 *      A drift here means something wrote to the balance column outside
 *      `postTransfer`, which is a more urgent problem than any custodian gap.
 *   2. Does the custodian agree with the ledger? `compareCustodyBalances` puts
 *      the omnibus's on-chain holdings against the total client liability.
 */

export interface ReconciliationLine {
  asset: string;
  /** What the custodian says it holds. */
  custodian: string;
  /** What the ledger says is owed to clients. */
  liability: string;
  /** `custodian - liability`. Negative is a shortfall. */
  difference: string;
  /**
   * False only when there is a shortfall — the custodian holds less than the
   * ledger owes. A surplus (FLT's own funds or accrued fee revenue sitting in
   * the omnibus) is reported but is not a failure.
   */
  ok: boolean;
}

export interface ReconciliationReport {
  ok: boolean;
  lines: ReconciliationLine[];
  checkedAt: Date;
}

/** Dust tolerance, in whole units. Rounding, not solvency. */
const EPSILON = new Decimal('0.000001');

/**
 * Compares the custodian's holdings against the ledger's client liability.
 *
 * Pure: it takes the two sides and returns the verdict. The worker fetches the
 * custodian side (through the custody port) and the ledger side, and calls this.
 */
export function compareCustodyBalances(
  custodian: readonly Pick<CustodyBalance, 'asset' | 'total'>[],
  liabilities: ReadonlyMap<string, Decimal>,
): ReconciliationReport {
  const assets = new Set<string>([
    ...custodian.map((balance) => balance.asset.trim().toUpperCase()),
    ...[...liabilities.keys()].map((asset) => asset.trim().toUpperCase()),
  ]);

  const lines: ReconciliationLine[] = [];
  let ok = true;

  for (const asset of assets) {
    const held = new Decimal(
      custodian.find((balance) => balance.asset.trim().toUpperCase() === asset)?.total ?? '0',
    );
    const owed = liabilities.get(asset) ?? new Decimal(0);
    const difference = held.minus(owed);

    // A shortfall is `owed > held`. Equal or surplus is fine: with the fee
    // recipient set to the omnibus, that surplus is revenue the omnibus is
    // holding, which is expected.
    const shortfall = owed.minus(held).greaterThan(EPSILON);
    if (shortfall) ok = false;

    lines.push({
      asset,
      custodian: held.toFixed(),
      liability: owed.toFixed(),
      difference: difference.toFixed(),
      ok: !shortfall,
    });
  }

  lines.sort((a, b) => Number(b.liability) - Number(a.liability));

  return { ok, lines, checkedAt: new Date() };
}

/**
 * The total client liability per asset, from the ledger.
 *
 * Sums the available and locked balances (both stored as credit balances, so
 * the raw sum is negative and is negated here) — a reserved balance is still
 * owed, and leaving it out would understate what must be covered.
 */
export async function clientLiabilities(): Promise<Map<string, Decimal>> {
  const rows = await prisma.ledgerAccount.groupBy({
    by: ['asset'],
    where: {
      kind: { in: [LedgerAccountKind.USER_AVAILABLE, LedgerAccountKind.USER_LOCKED] },
    },
    _sum: { balance: true },
  });

  const liabilities = new Map<string, Decimal>();
  for (const row of rows) {
    liabilities.set(row.asset, new Decimal(row._sum.balance?.toString() ?? '0').negated());
  }
  return liabilities;
}

export interface LedgerIntegrityIssue {
  accountId: string;
  asset: string;
  kind: string;
  cached: string;
  recomputed: string;
}

/**
 * Re-derives every account from its entries and reports any that disagree with
 * the cached balance.
 *
 * The cached `balance` is maintained in the same transaction as the entries
 * that move it, so the two should never differ. When they do, something wrote
 * the column outside `postTransfer` — the single most alarming thing this job
 * can find, and the one it should surface first.
 */
export async function ledgerIntegrityReport(): Promise<LedgerIntegrityIssue[]> {
  const accounts = await prisma.ledgerAccount.findMany();
  const issues: LedgerIntegrityIssue[] = [];

  for (const account of accounts) {
    const summed = await prisma.ledgerEntry.aggregate({
      where: { accountId: account.id },
      _sum: { amount: true },
    });
    const recomputed = new Decimal(summed._sum.amount?.toString() ?? '0');
    const cached = new Decimal(account.balance.toString());

    if (!recomputed.equals(cached)) {
      issues.push({
        accountId: account.id,
        asset: account.asset,
        kind: account.kind,
        cached: cached.toFixed(),
        recomputed: recomputed.toFixed(),
      });
    }
  }

  return issues;
}
