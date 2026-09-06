import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { newId } from '@flt/core/domain';
import { perpVenue } from '@flt/providers';

/**
 * Refreshes the perpetual market registry from the live venue.
 *
 * Exists because the alternative is hardcoding venue asset ids in a seed file,
 * and a wrong asset id does not fail loudly — it submits an order against a
 * different market than the one on screen. The venue is the only authority on
 * its own numbering, so the numbering is read from it.
 *
 * What this script does NOT do is decide what to offer. It creates rows
 * disabled, and it never flips `isEnabled` on a row that already exists.
 * Enabling a market stays an operator decision made in the admin panel, and a
 * metadata refresh must never quietly put a market back on sale that somebody
 * deliberately took off it.
 *
 * Usage:
 *   pnpm sync:perp-markets                 refresh metadata for known markets
 *   pnpm sync:perp-markets BTC ETH SOL     also create rows for these symbols
 */
async function main(): Promise<void> {
  const config = env();
  const venue = perpVenue();

  if (venue.meta.isMock) {
    console.warn(
      `PERP_VENUE=${config.PERP_VENUE} is a simulator. Registry rows written from it are not real markets.`,
    );
  }

  const requested = process.argv.slice(2).map((symbol) => symbol.toUpperCase());
  const live = await venue.listMarkets();
  const bySymbol = new Map(live.map((market) => [market.symbol, market]));

  console.info(`Venue ${venue.meta.slug}: ${live.length} markets, ${live.filter((m) => !m.isDelisted).length} live\n`);

  const existing = await prisma.perpMarket.findMany({
    where: { venueSlug: venue.meta.slug },
    select: { symbol: true },
  });

  const symbols = [...new Set([...existing.map((row) => row.symbol), ...requested])];
  if (symbols.length === 0) {
    console.info('No markets in the registry and none requested. Pass symbols to add some.');
    return;
  }

  let created = 0;
  let updated = 0;
  let missing = 0;

  for (const symbol of symbols) {
    const market = bySymbol.get(symbol);

    if (!market) {
      missing += 1;
      console.warn(`  ${symbol.padEnd(8)} not listed by the venue — left untouched`);
      continue;
    }

    if (market.isDelisted) {
      console.warn(`  ${symbol.padEnd(8)} delisted by the venue`);
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
        `  ${symbol.padEnd(8)} updated  assetId=${String(market.venueAssetId).padEnd(4)} venueMax=${market.maxLeverage}x  fltCap=${Math.min(row.maxLeverage, market.maxLeverage)}x  ${row.isEnabled ? 'enabled' : 'disabled'}`,
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
        `  ${symbol.padEnd(8)} created  assetId=${String(market.venueAssetId).padEnd(4)} venueMax=${market.maxLeverage}x  DISABLED`,
      );
    }
  }

  console.info(`\n${created} created, ${updated} updated, ${missing} not found on the venue.`);
  if (created > 0) {
    console.info('New markets are disabled. Enable them in the admin panel when you mean to offer them.');
  }
}

main()
  .catch((error) => {
    console.error('Registry sync failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
