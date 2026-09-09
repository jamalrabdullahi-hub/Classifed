import { getTranslations } from 'next-intl/server';
import { prisma } from '@flt/db';
import { env } from '@flt/config';
import {
  INSTRUMENT_GROUP_ORDER,
  displayName,
  groupForAssetClass,
  instrumentKey,
  usesSyntheticNaming,
  isMajorCryptoSymbol,
  type InstrumentGroup,
} from '@flt/core/services/instruments';
import { perpVenues } from '@flt/providers';
import { handler } from '@/server/api';

/**
 * One search across everything tradeable, grouped by what it is.
 *
 * ## Grouped, because "everything, ranked" was unreadable
 *
 * This used to return one flat ranked list mixing spot tokens and perpetuals.
 * With 2,600 imported tokens that meant a query for a major ticker came back
 * as a wall of near-identical rows, and the reader had to decode each one from
 * a trailing label. Results are now bucketed — perps, mimics, futures, forex,
 * commodities, then spot — so the shape of the answer is visible before any of
 * it is read.
 *
 * ## Perps outrank spot, deliberately
 *
 * Typing "BTC" into a trading platform means the Bitcoin market. It used to
 * land on the wallet swap screen, which is a different activity entirely. Spot
 * still appears, below, because buying the asset is a real thing to want — it
 * just is not the first thing somebody typing a ticker meant.
 *
 * ## Curation happens here, not in the registry
 *
 * The registry keeps every imported token; this endpoint declines to offer
 * most of them. A RECOGNIZED token has to be a major ticker to be surfaced at
 * all — see MAJOR_CRYPTO_SYMBOLS — while VERIFIED tokens always are, because
 * somebody at FLT actually checked those contracts. Nothing is deleted and an
 * operator can still enable anything; the search box just stops introducing
 * strangers.
 */
export const GET = handler({}, async ({ request }) => {
  const t = await getTranslations('instrumentSearch');
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') ?? '').trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 24), 1), 50);

  if (query.length < 1) return { query, groups: [] };

  const needle = query.toUpperCase();
  const config = env();

  const [tokens, perps] = await Promise.all([
    prisma.token.findMany({
      where: {
        isEnabled: true,
        chain: { isEnabled: true },
        OR: [
          { symbol: { contains: query, mode: 'insensitive' } },
          { name: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: {
        symbol: true,
        name: true,
        address: true,
        chainId: true,
        verificationTier: true,
        chain: { select: { name: true } },
      },
      take: 200,
    }),
    config.PERPS_ENABLED
      ? prisma.perpMarket.findMany({
          where: {
            isEnabled: true,
            // Only venues this deployment actually offers. Rows left over from
            // a simulator, or from a venue since switched off, are still in the
            // table and still enabled — returning them would offer a market
            // that does not exist anywhere an order could be sent.
            venueSlug: { in: perpVenues().map((venue) => venue.meta.slug) },
            OR: [
              { symbol: { contains: query, mode: 'insensitive' } },
              { name: { contains: query, mode: 'insensitive' } },
            ],
          },
          take: 200,
        })
      : Promise.resolve([]),
  ]);

  interface Entry {
    group: InstrumentGroup;
    kind: 'spot' | 'perp';
    symbol: string;
    name: string;
    href: string;
    detail: string;
    tier: string | null;
    address: string | null;
    rank: number;
  }

  const entries: Entry[] = [];

  for (const market of perps) {
    const rank = rankOf(needle, market.symbol, market.name);
    if (rank >= 90) continue;

    entries.push({
      group: groupForAssetClass(market.assetClass),
      kind: 'perp',
      symbol: market.symbol,
      name: displayName(market.symbol, market.name),
      href: `/ganacsi/${market.symbol}`,
      detail: t('perpDetail', {
        assetClass: market.assetClass.toLowerCase(),
        leverage: Math.min(market.maxLeverage, config.PERP_MAX_LEVERAGE),
      }),
      tier: null,
      address: null,
      rank,
    });
  }

  for (const token of tokens) {
    const rank = rankOf(needle, token.symbol, token.name);
    if (rank >= 90) continue;

    /**
     * The curation gate.
     *
     * VERIFIED means a person checked the contract, so it is always offered.
     * Everything else has to be a ticker somebody plausibly meant. Without
     * this, one bulk import decides what a search for "BTC" looks like.
     */
    const offerable =
      token.verificationTier === 'VERIFIED' || isMajorCryptoSymbol(token.symbol);
    if (!offerable) continue;

    entries.push({
      group: 'spot',
      kind: 'spot',
      symbol: token.symbol,
      name: token.name,
      href: `/iibso?buy=${token.address}`,
      detail: t('spotDetail', { chain: token.chain.name }),
      tier: token.verificationTier,
      address: token.address,
      // A verified contract wins a tie against a merely recognised one bearing
      // the same ticker — which is the whole point of having checked it.
      rank: rank + (token.verificationTier === 'VERIFIED' ? 0 : 0.1),
    });
  }

  /**
   * One row per instrument.
   *
   * Venues decorate the same underlying differently (AAPL, AAPL-USD, sAAPL),
   * and the same ticker exists as a token on several chains. Both produce
   * duplicate-looking rows that a reader cannot choose between, so the best
   * ranked one survives and the rest are dropped. Deduplication is per group,
   * so a BTC perp and BTC spot both still appear — those are genuinely
   * different things to do.
   */
  const best = new Map<string, Entry>();
  for (const entry of entries.sort((a, b) => a.rank - b.rank)) {
    const key = `${entry.group}:${instrumentKey(entry.symbol, {
      stripSyntheticAffixes: usesSyntheticNaming(entry.group),
    })}`;
    if (!best.has(key)) best.set(key, entry);
  }

  const deduped = [...best.values()];

  const groups = INSTRUMENT_GROUP_ORDER.map((group) => ({
    key: group,
    label: t(`group.${group}` as 'group.perp'),
    results: deduped
      .filter((entry) => entry.group === group)
      .sort((a, b) => a.rank - b.rank || a.symbol.localeCompare(b.symbol)),
  }))
    .filter((section) => section.results.length > 0);

  // Trimmed across groups in display order, so the cap never empties the
  // section the reader was most likely looking for.
  let remaining = limit;
  const trimmed = [];
  for (const section of groups) {
    if (remaining <= 0) break;
    trimmed.push({ ...section, results: section.results.slice(0, remaining) });
    remaining -= section.results.length;
  }

  return { query, groups: trimmed };
});

/** Lower is a better match. 99 means it does not really match at all. */
function rankOf(needle: string, symbol: string, name: string): number {
  const upperSymbol = symbol.toUpperCase();
  const upperName = name.toUpperCase();

  if (upperSymbol === needle) return 0;
  if (upperSymbol.startsWith(needle)) return 1;
  if (upperName === needle) return 2;
  if (upperName.startsWith(needle)) return 3;
  if (upperSymbol.includes(needle)) return 4;
  if (upperName.includes(needle)) return 5;
  return 99;
}
