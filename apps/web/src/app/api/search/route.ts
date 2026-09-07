import { getTranslations } from 'next-intl/server';
import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { perpVenues } from '@flt/providers';
import { handler } from '@/server/api';

/**
 * One search across everything tradeable.
 *
 * Spot tokens and perpetual markets live in different tables and trade through
 * different venues, but a person looking for "SOL" does not care which — they
 * want the instrument. So this returns both, labelled, and the interface routes
 * on the label rather than making the user pick a table first.
 *
 * ## Ranking, not filtering
 *
 * With 2,600 spot tokens a substring match on "BTC" returns dozens of things
 * before Bitcoin. So results are ranked: exact symbol, then symbol prefix, then
 * name prefix, then contains — and within a rank, verified tokens before
 * recognised ones, because a scanner full of unreviewed lookalikes is how
 * somebody buys the wrong contract.
 *
 * Perps sort ahead of spot on an equal rank: the perp list is small and
 * deliberately curated, so a match there is more likely to be the thing meant.
 */
export const GET = handler({}, async ({ request }) => {
  const t = await getTranslations('instrumentSearch');
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') ?? '').trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20), 1), 50);

  if (query.length < 1) {
    return { query, results: [] };
  }

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
      // Bounded before ranking: a two-character query matches hundreds and
      // there is no reason to pull them all into memory to sort them.
      take: 200,
    }),
    config.PERPS_ENABLED
      ? prisma.perpMarket.findMany({
          where: {
            isEnabled: true,
            // Only venues this deployment actually offers. Rows left over
            // from a simulator, or from a venue since switched off, are still
            // in the table and still enabled — returning them would offer a
            // market that does not exist anywhere an order could be sent.
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

  /**
   * Symbols shared by more than one token.
   *
   * A bulk import from a public list brings in lookalikes: Base has two tokens
   * whose symbol is BTC — "Big Tom Coin" and "Bitcoin Base" — and neither is
   * Bitcoin. Left undistinguished, a search for BTC offers two identical-looking
   * rows and the person picks one at random. Where a symbol collides, the
   * contract address is surfaced so the rows can actually be told apart.
   */
  const symbolCounts = new Map<string, number>();
  for (const token of tokens) {
    const key = token.symbol.toUpperCase();
    symbolCounts.set(key, (symbolCounts.get(key) ?? 0) + 1);
  }

  const results = [
    ...perps.map((market) => ({
      kind: 'perp' as const,
      symbol: market.symbol,
      name: market.name,
      href: `/perps/${market.symbol}`,
      detail: t('perpDetail', {
        assetClass: market.assetClass.toLowerCase(),
        leverage: Math.min(market.maxLeverage, config.PERP_MAX_LEVERAGE),
      }),
      assetClass: market.assetClass,
      tier: null as string | null,
      address: null as string | null,
      ambiguous: false,
      rank: rankOf(needle, market.symbol, market.name) - 0.5,
    })),
    ...tokens.map((token) => ({
      kind: 'spot' as const,
      symbol: token.symbol,
      name: token.name,
      href: `/trade?token=${token.address}&chain=${token.chainId}`,
      detail: t('spotDetail', { chain: token.chain.name }),
      address: token.address,
      /** True when another enabled token shares this symbol. */
      ambiguous: (symbolCounts.get(token.symbol.toUpperCase()) ?? 0) > 1,
      assetClass: null as string | null,
      tier: token.verificationTier,
      rank:
        rankOf(needle, token.symbol, token.name) +
        (token.verificationTier === 'VERIFIED' ? 0 : token.verificationTier === 'RECOGNIZED' ? 0.1 : 0.2),
    })),
  ]
    .filter((entry) => entry.rank < 90)
    .sort((a, b) => a.rank - b.rank || a.symbol.localeCompare(b.symbol))
    .slice(0, limit);

  return { query, results };
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
