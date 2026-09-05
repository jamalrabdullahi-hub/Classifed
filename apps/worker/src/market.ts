import { prisma } from '@flt/db';
import { newId } from '@flt/core/domain';
import { BASE_CHAIN_ID } from '@flt/core/chains';
import { marketDataProvider } from '@flt/providers';

/**
 * Market data refresh.
 *
 * Cached in the database rather than fetched per page render, because free
 * market-data tiers rate-limit aggressively and a portfolio page that fans out
 * one request per token would exhaust the allowance in minutes.
 *
 * A token the provider does not know is left alone rather than written as zero.
 * The interface renders a missing price as "—", which is honest; a zero would
 * read as "worthless".
 */

export interface MarketRefreshResult {
  requested: number;
  updated: number;
}

export async function refreshMarketData(): Promise<MarketRefreshResult> {
  const tokens = await prisma.token.findMany({
    where: { isEnabled: true, chainId: BASE_CHAIN_ID },
    select: { id: true, address: true },
  });

  if (tokens.length === 0) return { requested: 0, updated: 0 };

  const data = await marketDataProvider().getTokenData({
    chainId: BASE_CHAIN_ID,
    tokenAddresses: tokens.map((token) => token.address),
  });

  const byAddress = new Map(data.map((entry) => [entry.tokenAddress.toLowerCase(), entry]));
  let updated = 0;

  for (const token of tokens) {
    const entry = byAddress.get(token.address.toLowerCase());
    if (!entry) continue;

    await prisma.marketDataCache.upsert({
      where: { tokenId: token.id },
      create: {
        id: newId(),
        tokenId: token.id,
        priceUsd: entry.priceUsd,
        change24hPct: entry.change24hPct,
        volume24hUsd: entry.volume24hUsd,
        liquidityUsd: entry.liquidityUsd,
        marketCapUsd: entry.marketCapUsd,
        source: entry.source,
        fetchedAt: entry.fetchedAt,
      },
      update: {
        priceUsd: entry.priceUsd,
        change24hPct: entry.change24hPct,
        volume24hUsd: entry.volume24hUsd,
        liquidityUsd: entry.liquidityUsd,
        marketCapUsd: entry.marketCapUsd,
        source: entry.source,
        fetchedAt: entry.fetchedAt,
      },
    });

    updated += 1;
  }

  return { requested: tokens.length, updated };
}
