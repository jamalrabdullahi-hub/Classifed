import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { newId } from '@flt/core/domain';
import { perpVenues } from '@flt/providers';

/**
 * Refreshes the perpetual market registry from every offered venue.
 *
 * Exists because the alternative is hardcoding venue asset ids in a seed file,
 * and a wrong asset id does not fail loudly — it submits an order against a
 * different market than the one on screen. The venue is the only authority on
 * its own numbering, so the numbering is read from it.
 *
 * ## Every venue, not just the first
 *
 * This used to sync only `perpVenue()` — the single `PERP_VENUE` — which meant
 * Ostium's equities, indices, FX and commodities could never enter the registry:
 * `PERP_VENUE` has no `ostium` value, and a market has to be resolved *by venue*
 * (both list BTC). So a forex or stock symbol like USD/CAD had no row to resolve
 * and 404'd however the URL was written. It now iterates `perpVenues()`.
 *
 * What this script does NOT do is decide what to offer. It creates rows
 * disabled, and it never flips `isEnabled` on a row that already exists.
 * Enabling a market stays an operator decision made in the admin panel, and a
 * metadata refresh must never quietly put a market back on sale that somebody
 * deliberately took off it.
 *
 * Usage:
 *   pnpm sync:perp-markets                 refresh metadata for known markets
 *   pnpm sync:perp-markets BTC USD/CAD     also create rows for these symbols
 */
async function main(): Promise<void> {
  const config = env();
  const venues = perpVenues();
  const requested = process.argv.slice(2).map((symbol) => symbol.toUpperCase());

  let totalCreated = 0;
  let totalUpdated = 0;

  for (const venue of venues) {
    if (venue.meta.isMock) {
      console.warn(
        `Venue ${venue.meta.slug} is a simulator. Registry rows written from it are not real markets.`,
      );
    }

    const live = await venue.listMarkets();
    const bySymbol = new Map(live.map((market) => [market.symbol, market]));

    console.info(
      `\nVenue ${venue.meta.slug}: ${live.length} markets, ${live.filter((m) => !m.isDelisted).length} live`,
    );

    const existing = await prisma.perpMarket.findMany({
      where: { venueSlug: venue.meta.slug },
      select: { symbol: true },
    });

    const symbols = [...new Set([...existing.map((row) => row.symbol), ...requested])];
    if (symbols.length === 0) {
      console.info('  nothing in the registry and none requested.');
      continue;
    }

    let created = 0;
    let updated = 0;
    let missing = 0;

    for (const symbol of symbols) {
      const market = bySymbol.get(symbol);

      if (!market) {
        missing += 1;
        console.warn(`  ${symbol.padEnd(10)} not listed by the venue — left untouched`);
        continue;
      }

      if (market.isDelisted) {
        console.warn(`  ${symbol.padEnd(10)} delisted by the venue`);
      }

      const row = await prisma.perpMarket.findUnique({
        where: { venueSlug_symbol: { venueSlug: venue.meta.slug, symbol } },
      });

      if (row) {
        await prisma.perpMarket.update({
          where: { id: row.id },
          data: {
            name: market.name,
            venueAssetId: market.venueAssetId,
            venueMaxLeverage: market.maxLeverage,
            sizeDecimals: market.sizeDecimals,
            minSize: market.minSize,
            // FLT's own cap only ever moves down here, never up: if the venue
            // lowered its maximum, ours has to follow, but a venue raising its
            // limit is not permission to raise ours.
            maxLeverage: Math.min(row.maxLeverage, market.maxLeverage),
          },
        });
        updated += 1;
        console.info(
          `  ${symbol.padEnd(10)} updated  assetId=${String(market.venueAssetId).padEnd(5)} venueMax=${market.maxLeverage}x  fltCap=${Math.min(row.maxLeverage, market.maxLeverage)}x  ${row.isEnabled ? 'enabled' : 'disabled'}`,
        );
      } else {
        await prisma.perpMarket.create({
          data: {
            id: newId(),
            venueSlug: venue.meta.slug,
            symbol: market.symbol,
            name: market.name,
            venueAssetId: market.venueAssetId,
            venueMaxLeverage: market.maxLeverage,
            maxLeverage: Math.min(config.PERP_MAX_LEVERAGE, market.maxLeverage),
            sizeDecimals: market.sizeDecimals,
            minSize: market.minSize,
            // Created switched off. Listing a market is not offering it.
            isEnabled: false,
            disabledReason: 'Added by registry sync; not yet reviewed for trading',
          },
        });
        created += 1;
        console.info(
          `  ${symbol.padEnd(10)} created  assetId=${String(market.venueAssetId).padEnd(5)} venueMax=${market.maxLeverage}x  DISABLED`,
        );
      }
    }

    console.info(`  → ${created} created, ${updated} updated, ${missing} not found on ${venue.meta.slug}.`);
    totalCreated += created;
    totalUpdated += updated;
  }

  console.info(`\nTotal across ${venues.length} venue(s): ${totalCreated} created, ${totalUpdated} updated.`);
  if (totalCreated > 0) {
    console.info('New markets are disabled. Enable them in the admin panel when you mean to offer them.');
  }
}

main()
  .catch((error) => {
    console.error('Registry sync failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
