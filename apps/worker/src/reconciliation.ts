import { custodyProvider, perpVenue } from '@flt/providers';
import {
  clientLiabilities,
  compareCustodyBalances,
  ledgerIntegrityReport,
} from '@flt/core/services/custody-reconciliation';
import { LedgerAccountKind, prisma } from '@flt/db';
import { env } from '@flt/config';
import { Decimal } from '@flt/core/domain';

/**
 * Reconciliation, run on a slow interval.
 *
 * The single most important thing the worker does. It asks three questions and
 * answers none of them by writing a number:
 *
 *   1. Does the ledger agree with itself? (cached balance vs its entries)
 *   2. Does the omnibus hold at least what the ledger owes? (spot custody)
 *   3. Does the venue hold at least the margin the ledger claims there? (perps)
 *
 * A divergence is logged loudly and returned; it is never resolved here.
 * Auto-correcting a balance to match the chain (or the venue) would cancel the
 * check that proves the ledger is backed. See `docs/adr/0004-custodial-omnibus.md`
 * and `docs/adr/0005-perps-custody.md`.
 *
 * No-ops when custody is off. The venue leg no-ops on a mock venue, which has no
 * real money to reconcile.
 */

export interface ReconciliationResult {
  shortfalls: number;
  integrityIssues: number;
  venueShortfalls: number;
}

/**
 * The venue leg: VENUE_MARGIN (the ledger's claim on the venue) must not exceed
 * the venue account's actual value.
 *
 * A surplus is expected and fine — it is the venue's open unrealized PnL, which
 * the ledger deliberately does not carry (realized-only). A shortfall — the
 * ledger claiming more than the venue holds — is the finding.
 */
async function reconcileVenue(): Promise<number> {
  if (!env().PERPS_ENABLED || env().CUSTODY_PROVIDER === 'disabled') return 0;

  const venue = perpVenue();
  if (venue.meta.isMock) return 0; // no real money behind a simulated venue

  const omnibus = env().OMNIBUS_EVM_ADDRESS;
  if (!omnibus) return 0;

  const summary = await venue.getAccountSummary({ address: omnibus });
  const venueValue = new Decimal(summary.accountValue ?? '0');

  const row = await prisma.ledgerAccount.findFirst({
    where: { kind: LedgerAccountKind.VENUE_MARGIN },
  });
  const ledgerMargin = row ? new Decimal(row.balance.toString()) : new Decimal(0);

  const difference = venueValue.minus(ledgerMargin);
  if (difference.lessThan(new Decimal('0').minus('0.000001'))) {
    console.error(
      '[reconciliation] VENUE SHORTFALL — the ledger claims more venue margin than the venue holds',
      {
        venue: venueValue.toFixed(),
        ledger: ledgerMargin.toFixed(),
        difference: difference.toFixed(),
      },
    );
    return 1;
  }
  return 0;
}

export async function runReconciliation(): Promise<ReconciliationResult> {
  const provider = custodyProvider();
  if (!provider) return { shortfalls: 0, integrityIssues: 0, venueShortfalls: 0 };

  const [custodian, liabilities, integrity] = await Promise.all([
    provider.getBalances(),
    clientLiabilities(),
    ledgerIntegrityReport(),
  ]);

  const report = compareCustodyBalances(custodian, liabilities);

  for (const line of report.lines) {
    if (!line.ok) {
      console.error(
        '[reconciliation] SHORTFALL — the ledger owes more than the omnibus holds',
        line,
      );
    }
  }

  for (const issue of integrity) {
    console.error(
      '[reconciliation] LEDGER DRIFT — a cached balance disagrees with its entries',
      issue,
    );
  }

  const venueShortfalls = await reconcileVenue();

  return {
    shortfalls: report.lines.filter((line) => !line.ok).length,
    integrityIssues: integrity.length,
    venueShortfalls,
  };
}
