import { prisma } from '@flt/db';
import type { PerpVenue } from '@flt/core/ports';
import { perpVenues } from '@flt/providers';

/**
 * Creates and enables the venue's full market list.
 *
 * `sync-perp-markets` deliberately creates rows disabled and never re-enables
 * one, because a metadata refresh must not put a market back on sale that
 * somebody took off it. This is the separate, explicit decision that script
 * refuses to make on its own — offering everything the venue lists.
 *
 * It still refuses to enable a delisted market: the venue reporting a market as
 * delisted is not a matter of operator preference, and an enabled row for one
 * would render with no price.
 *
 * Usage:
 *   pnpm tsx scripts/enable-perp-markets.ts            enable everything live
 *   pnpm tsx scripts/enable-perp-markets.ts --dry-run  say what would change
 *   pnpm tsx scripts/enable-perp-markets.ts --max 20   cap FLT leverage at 20x
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const maxIndex = args.indexOf('--max');
  const fltCap = maxIndex >= 0 ? Number(args[maxIndex + 1]) : null;

  if (fltCap !== null && (!Number.isInteger(fltCap) || fltCap < 1 || fltCap > 100)) {
    throw new Error('--max must be a whole number between 1 and 100');
  }

  for (const venue of perpVenues()) {
    await syncVenue(venue, { dryRun, fltCap });
  }
}

/**
 * One venue's markets.
 *
 * Asset class comes from the venue rather than from a table here. Ostium
 * publishes its own grouping; Hyperliquid lists crypto only. A classifier in
 * this script would have to guess, and the guess that matters — is `SPX` the
 * index or the memecoin? — has opposite answers on the two venues.
 */
async function syncVenue(
  venue: PerpVenue,
  options: { dryRun: boolean; fltCap: number | null },
): Promise<void> {
  const { dryRun, fltCap } = options;
  const live = await venue.listMarkets();
  const tradeable = live.filter((market) => !market.isDelisted);

  console.info(
    `Venue ${venue.meta.slug}: ${live.length} markets, ${tradeable.length} tradeable, ` +
      `${live.length - tradeable.length} delisted\n`,
  );

  const existing = await prisma.perpMarket.findMany({
    where: { venueSlug: venue.meta.slug },
  });
  const bySymbol = new Map(existing.map((row) => [row.symbol, row]));

  let created = 0;
  let enabled = 0;
  let updated = 0;

  for (const market of tradeable) {
    const row = bySymbol.get(market.symbol);
    // FLT's own ceiling, never above the venue's — the lower always wins.
    const cap = Math.min(fltCap ?? market.maxLeverage, market.maxLeverage);

    if (!row) {
      created += 1;
      if (!dryRun) {
        await prisma.perpMarket.create({
          data: {
            id: crypto.randomUUID(),
            venueSlug: venue.meta.slug,
            symbol: market.symbol,
            name: market.name,
            venueAssetId: market.venueAssetId,
            venueMaxLeverage: market.maxLeverage,
            maxLeverage: cap,
            sizeDecimals: market.sizeDecimals,
            minSize: market.minSize,
            assetClass: market.assetClass,
            isEnabled: true,
          },
        });
      }
      continue;
    }

    const needsEnable = !row.isEnabled;
    // The venue is the authority on its own numbering and limits, so those are
    // refreshed even on a row that already exists.
    const needsUpdate =
      row.venueAssetId !== market.venueAssetId ||
      row.venueMaxLeverage !== market.maxLeverage ||
      row.sizeDecimals !== market.sizeDecimals ||
      row.minSize !== market.minSize ||
      row.assetClass !== market.assetClass ||
      (fltCap !== null && row.maxLeverage !== cap);

    if (!needsEnable && !needsUpdate) continue;

    if (needsEnable) enabled += 1;
    else updated += 1;

    if (!dryRun) {
      await prisma.perpMarket.update({
        where: { id: row.id },
        data: {
          name: market.name,
          venueAssetId: market.venueAssetId,
          venueMaxLeverage: market.maxLeverage,
          sizeDecimals: market.sizeDecimals,
          minSize: market.minSize,
          assetClass: market.assetClass,
          isEnabled: true,
          disabledReason: null,
          ...(fltCap !== null ? { maxLeverage: cap } : {}),
        },
      });
    }
  }

  // A row we list that the venue no longer does is switched off rather than
  // deleted: the orders and policies pointing at it are still real history.
  const liveSymbols = new Set(tradeable.map((market) => market.symbol));
  const stale = existing.filter((row) => row.isEnabled && !liveSymbols.has(row.symbol));

  for (const row of stale) {
    if (!dryRun) {
      await prisma.perpMarket.update({
        where: { id: row.id },
        data: { isEnabled: false, disabledReason: 'No longer listed by the venue' },
      });
    }
  }

  const total = await prisma.perpMarket.count({
    where: { venueSlug: venue.meta.slug, isEnabled: true },
  });

  console.info(`${dryRun ? 'Would create' : 'Created'}  ${created}`);
  console.info(`${dryRun ? 'Would enable' : 'Enabled'}  ${enabled}`);
  console.info(`${dryRun ? 'Would refresh' : 'Refreshed'} ${updated}`);
  console.info(`${dryRun ? 'Would disable' : 'Disabled'} ${stale.length} no longer listed`);
  console.info(`\nEnabled markets now: ${dryRun ? '(unchanged)' : total}`);
}

main()
  .catch((error) => {
    console.error('FAILED:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
