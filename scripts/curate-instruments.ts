import { prisma } from '@flt/db';
import {
  MAJOR_CRYPTO_SYMBOLS,
  groupForAssetClass,
  instrumentKey,
  usesSyntheticNaming,
} from '@flt/core/services/instruments';

/**
 * Narrows what the platform offers to what somebody would recognise.
 *
 * Two jobs, both idempotent, neither destructive:
 *
 *  1. **Spot.** Disables tokens that are neither VERIFIED nor a major ticker.
 *     `isEnabled = false`, never a delete — the row keeps its market data and
 *     an operator can turn any of it back on from the admin panel. A bulk
 *     import brought in roughly 2,600 tokens and made a search for "BTC"
 *     return Big Tom Coin; this is the counterweight to that import, not a
 *     retraction of it.
 *
 *  2. **Perp mimics.** Venues list the same underlying several times — AAPL,
 *     AAPL-USD, sAAPL, AAPLx all track Apple — so a person looking for one
 *     company sees five rows they cannot choose between. Where several enabled
 *     markets collapse to the same instrument key, the one with the highest
 *     FLT leverage ceiling is kept (ties broken by the shortest symbol, which
 *     is reliably the undecorated one) and the rest are disabled.
 *
 * The search endpoint and the scanner already apply the same curation at read
 * time, so running this is not required for the interface to behave. It is
 * what makes the *registry itself* agree with what is shown — which matters
 * for the admin panel, for exports, and for anything that queries the tables
 * directly.
 *
 * Usage:
 *   pnpm tsx scripts/curate-instruments.ts --dry-run
 *   pnpm tsx scripts/curate-instruments.ts
 */

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const label = dryRun ? '[dry run]' : '[applying]';
  console.info(`${label} curating the instrument registry\n`);

  // ── Spot ──────────────────────────────────────────────────────────────────
  const majors = [...MAJOR_CRYPTO_SYMBOLS];

  const doomed = await prisma.token.findMany({
    where: {
      isEnabled: true,
      verificationTier: { not: 'VERIFIED' },
      symbol: { notIn: majors },
    },
    select: { address: true, chainId: true, symbol: true },
  });

  console.info(`spot   ${doomed.length} tokens to disable`);
  for (const token of doomed.slice(0, 10)) {
    console.info(`         ${token.symbol}`);
  }
  if (doomed.length > 10) console.info(`         …and ${doomed.length - 10} more`);

  if (!dryRun && doomed.length > 0) {
    const { count } = await prisma.token.updateMany({
      where: {
        isEnabled: true,
        verificationTier: { not: 'VERIFIED' },
        symbol: { notIn: majors },
      },
      data: {
        isEnabled: false,
        disabledReason: 'Not a reviewed contract or a major ticker (curate-instruments)',
      },
    });
    console.info(`spot   disabled ${count}`);
  }

  // ── Perp mimics and other duplicated underlyings ──────────────────────────
  const markets = await prisma.perpMarket.findMany({
    where: { isEnabled: true },
    select: {
      id: true,
      symbol: true,
      name: true,
      venueSlug: true,
      maxLeverage: true,
      assetClass: true,
    },
  });

  const byInstrument = new Map<string, typeof markets>();
  for (const market of markets) {
    const group = groupForAssetClass(market.assetClass);
    const key = `${market.assetClass}:${instrumentKey(market.symbol, {
      stripSyntheticAffixes: usesSyntheticNaming(group),
    })}`;
    byInstrument.set(key, [...(byInstrument.get(key) ?? []), market]);
  }

  const losers: { id: string; symbol: string; keptSymbol: string }[] = [];
  for (const group of byInstrument.values()) {
    if (group.length < 2) continue;

    const ranked = [...group].sort(
      (a, b) => b.maxLeverage - a.maxLeverage || a.symbol.length - b.symbol.length,
    );
    const [keep, ...rest] = ranked;
    for (const market of rest) {
      losers.push({ id: market.id, symbol: market.symbol, keptSymbol: keep!.symbol });
    }
  }

  console.info(`\nperps  ${losers.length} duplicate markets to disable`);
  for (const loser of losers.slice(0, 15)) {
    console.info(`         ${loser.symbol} → keeping ${loser.keptSymbol}`);
  }
  if (losers.length > 15) console.info(`         …and ${losers.length - 15} more`);

  if (!dryRun && losers.length > 0) {
    const { count } = await prisma.perpMarket.updateMany({
      where: { id: { in: losers.map((loser) => loser.id) } },
      data: {
        isEnabled: false,
        disabledReason: 'Duplicate of another market for the same underlying (curate-instruments)',
      },
    });
    console.info(`perps  disabled ${count}`);
  }

  console.info(dryRun ? '\nNothing was written. Re-run without --dry-run to apply.' : '\nDone.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
