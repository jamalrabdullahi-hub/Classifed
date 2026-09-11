/**
 * One-off: post the venue funding that happened before the ledger wiring existed,
 * so VENUE_MARGIN matches the venue's actual value. An operator reconciliation
 * action, not an auto-adjustment.
 *
 *   tsx --env-file-if-exists=../../apps/worker/.env scripts/perps-fund-backfill.ts
 */
import { LedgerAccountKind, prisma } from '@flt/db';
import { Decimal } from '@flt/core/domain';
import { env } from '@flt/config';
import { fundVenueMargin } from '@flt/core/services';
import { HyperliquidPerpVenue } from '../src';

async function main(): Promise<void> {
  const venue = new HyperliquidPerpVenue();
  const summary = await venue.getAccountSummary({ address: env().OMNIBUS_EVM_ADDRESS! });
  const venueValue = new Decimal(summary.accountValue ?? '0');

  const row = await prisma.ledgerAccount.findFirst({
    where: { kind: LedgerAccountKind.VENUE_MARGIN },
  });
  const ledger = row ? new Decimal(row.balance.toString()) : new Decimal(0);

  const delta = venueValue.minus(ledger);
  console.info(`venue ${venueValue.toFixed()} · ledger ${ledger.toFixed()} · posting ${delta.toFixed()}`);

  if (delta.lessThanOrEqualTo(0)) {
    console.info('nothing to post (the ledger already covers the venue)');
    return;
  }

  await fundVenueMargin({ amount: delta, reference: 'venue-fund-backfill:initial' });
  console.info('posted');
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
