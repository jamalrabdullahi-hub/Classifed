/**
 * Reconciliation run. Exits non-zero when the books are not healthy, so it can
 * be wired to a scheduler or a monitor.
 *
 *   npm run reconcile
 *   npm run reconcile -- --rebuild   (repair projections from the entries)
 */
import { prisma } from '../src/server/db';
import { rebuildProjections, reconcile } from '../src/services/reconcile';

async function main(): Promise<void> {
  const rebuild = process.argv.includes('--rebuild');

  if (rebuild) {
    const count = await rebuildProjections();
    console.log(`Rebuilt projections for ${count} accounts from ledger entries.\n`);
  }

  const report = await reconcile();

  console.log(`Reconciliation at ${report.ranAt.toISOString()}`);
  console.log(`Accounts checked: ${report.accountsChecked}\n`);

  console.log('Ledger totals (must be zero per asset):');
  for (const total of report.ledgerTotals) {
    console.log(`  ${total.balanced ? 'OK  ' : 'FAIL'} ${total.assetSymbol.padEnd(6)} ${total.total}`);
  }

  console.log('\nSolvency (assets held vs owed to customers):');
  for (const s of report.solvency) {
    const short = s.surplus.trim().startsWith('-');
    console.log(
      `  ${short ? 'FAIL' : 'OK  '} ${s.assetSymbol.padEnd(6)} owed ${s.owedToCustomers}  held ${s.held}  surplus ${s.surplus}`,
    );
  }

  if (report.drift.length > 0) {
    console.log(`\nProjection drift (${report.drift.length}):`);
    for (const row of report.drift) {
      console.log(
        `  ${row.code} ${row.assetSymbol} account=${row.accountId} projected=${row.projected} computed=${row.computed} drift=${row.drift}`,
      );
    }
    console.log('\n  Repair with: npm run reconcile -- --rebuild');
  } else {
    console.log('\nProjection drift: none');
  }

  if (report.stuck.length > 0) {
    console.log(`\nStuck records (${report.stuck.length}):`);
    for (const record of report.stuck) {
      console.log(`  ${record.kind} ${record.id} [${record.status}] ${record.ageMinutes}m — ${record.detail}`);
    }
  } else {
    console.log('Stuck records: none');
  }

  console.log(`\nResult: ${report.healthy ? 'HEALTHY' : 'ATTENTION REQUIRED'}`);
  await prisma.$disconnect();
  process.exit(report.healthy ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(2);
});
