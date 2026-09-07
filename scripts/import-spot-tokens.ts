import { prisma } from '@flt/db';
import { getAddress } from 'viem';

/**
 * Imports a chain's tokens from a standard token list.
 *
 * The registry was hand-curated, which is right for seven tokens and hopeless
 * for a scanner. This pulls a reputable list and imports it wholesale.
 *
 * ## Why RECOGNIZED and not VERIFIED
 *
 * Appearing on CoinGecko's list means the token exists and has been indexed. It
 * does not mean anybody at FLT looked at it. The registry already has a word
 * for that — RECOGNIZED, "known token from a reputable list, not individually
 * reviewed" — and the interface flags it accordingly. Importing two and a half
 * thousand tokens as VERIFIED would make the word meaningless for the seven
 * that earned it.
 *
 * A token already in the registry is never downgraded: an existing VERIFIED row
 * keeps its tier, and a row somebody deliberately disabled stays disabled. A
 * bulk import must not undo a human decision.
 *
 * Usage:
 *   pnpm tsx scripts/import-spot-tokens.ts                 Base, from CoinGecko
 *   pnpm tsx scripts/import-spot-tokens.ts --dry-run
 *   pnpm tsx scripts/import-spot-tokens.ts --chain 8453 --limit 500
 */

const LISTS: Record<number, { url: string; source: string }> = {
  8453: { url: 'https://tokens.coingecko.com/base/all.json', source: 'CoinGecko' },
  1: { url: 'https://tokens.coingecko.com/ethereum/all.json', source: 'CoinGecko' },
  42161: { url: 'https://tokens.coingecko.com/arbitrum-one/all.json', source: 'CoinGecko' },
  10: { url: 'https://tokens.coingecko.com/optimistic-ethereum/all.json', source: 'CoinGecko' },
};

interface ListedToken {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const chainIndex = args.indexOf('--chain');
  const chainId = chainIndex >= 0 ? Number(args[chainIndex + 1]) : 8453;

  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity;

  const list = LISTS[chainId];
  if (!list) {
    throw new Error(`No token list configured for chain ${chainId}`);
  }

  const chain = await prisma.chain.findUnique({ where: { chainId } });
  if (!chain) {
    throw new Error(`Chain ${chainId} is not in the registry. Add it before importing tokens.`);
  }

  const response = await fetch(list.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`${list.source} returned ${response.status}`);
  }

  const payload = (await response.json()) as { tokens: ListedToken[] };
  const listed = payload.tokens.filter((token) => token.chainId === chainId);

  console.info(`${list.source}: ${listed.length} tokens on ${chain.name}\n`);

  const existing = await prisma.token.findMany({ where: { chainId } });
  const byAddress = new Map(existing.map((row) => [row.address.toLowerCase(), row]));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let malformed = 0;

  for (const token of listed.slice(0, limit)) {
    // A list entry with a bad address or impossible decimals is a defect in the
    // list, not a token we should guess about.
    let address: string;
    try {
      address = getAddress(token.address);
    } catch {
      malformed += 1;
      continue;
    }

    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
      malformed += 1;
      continue;
    }
    if (!token.symbol?.trim() || token.symbol.length > 32) {
      malformed += 1;
      continue;
    }

    const row = byAddress.get(address.toLowerCase());

    if (row) {
      // Never re-enable, never downgrade the tier: both would undo a decision
      // somebody made deliberately.
      const needsLogo = !row.logoUrl && token.logoURI;
      if (!needsLogo) {
        skipped += 1;
        continue;
      }
      updated += 1;
      if (!dryRun) {
        await prisma.token.update({
          where: { id: row.id },
          data: { logoUrl: token.logoURI ?? null },
        });
      }
      continue;
    }

    created += 1;
    if (!dryRun) {
      await prisma.token.create({
        data: {
          id: crypto.randomUUID(),
          chainId,
          address,
          symbol: token.symbol.trim(),
          name: token.name?.trim() || token.symbol.trim(),
          decimals: token.decimals,
          logoUrl: token.logoURI ?? null,
          verificationTier: 'RECOGNIZED',
          isEnabled: true,
        },
      });
    }
  }

  const total = await prisma.token.count({ where: { chainId, isEnabled: true } });

  console.info(`${dryRun ? 'Would create' : 'Created'}  ${created}`);
  console.info(`${dryRun ? 'Would update' : 'Updated'}  ${updated} (logo only)`);
  console.info(`Left alone ${skipped} already in the registry`);
  console.info(`Rejected   ${malformed} malformed entries`);
  console.info(`\nEnabled tokens on ${chain.name}: ${dryRun ? '(unchanged)' : total}`);
}

main()
  .catch((error) => {
    console.error('FAILED:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
