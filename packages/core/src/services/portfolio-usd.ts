import { LedgerAccountKind, prisma } from '@flt/db';
import { Decimal } from '../domain/money';
import { BASE_CHAIN_ID } from '../chains';
import { naturalBalance } from './ledger';

/**
 * A participant's balance, read from the custody ledger.
 *
 * Under custody the ledger is the source of truth: what a participant holds is
 * the value FLT owes them, held as `USER_AVAILABLE` (spendable) and
 * `USER_LOCKED` (reserved against an open trade). The chain is consulted only
 * to *price* those holdings, never to decide what they are — reading a wallet
 * would show nothing, because the funds are pooled in the omnibus. See
 * `docs/adr/0004-custodial-omnibus.md`.
 *
 * ## Two figures, because two questions
 *
 * `totalUsd` is what the whole account is worth — every asset, valued. That is
 * the portfolio. `buyingPowerUsd` is only the stablecoin that can actually be
 * spent right now, which is the number a participant checks before opening a
 * trade. Conflating them would either overstate what is spendable or understate
 * what is held.
 *
 * ## Estimation, labelled as such
 *
 * A stablecoin is worth its face value. Any other asset takes whatever price
 * the market-data cache last recorded, and is marked `complete: false` when
 * there is none — a holding we could not price shows as unknown rather than as
 * zero, because "we could not value this" and "this is worth nothing" are
 * different statements.
 */

/** Symbols treated as $1 face value, matching the rest of the platform. */
const STABLECOINS = new Set(['USDC', 'USDT']);

export interface CustodyHolding {
  /** Symbol, e.g. "USDC". The ledger's asset key. */
  asset: string;
  /** Display name from the registry, when the asset is known there. */
  name: string | null;
  /** Whole units, as a decimal string. */
  available: string;
  locked: string;
  /** Decimals for formatting, when the asset is in the registry. */
  decimals: number | null;
  priceUsd: string | null;
  valueUsd: string | null;
  /** False when the holding could not be valued (no price available). */
  complete: boolean;
}

export interface CustodyPortfolio {
  totalUsd: string;
  buyingPowerUsd: string;
  holdings: CustodyHolding[];
}

export async function custodyPortfolio(userId: string): Promise<CustodyPortfolio> {
  const accounts = await prisma.ledgerAccount.findMany({
    where: {
      userId,
      kind: { in: [LedgerAccountKind.USER_AVAILABLE, LedgerAccountKind.USER_LOCKED] },
    },
  });

  // One entry per asset, available and locked folded together.
  const byAsset = new Map<string, { available: Decimal; locked: Decimal }>();
  for (const account of accounts) {
    const entry = byAsset.get(account.asset) ?? {
      available: new Decimal(0),
      locked: new Decimal(0),
    };
    const natural = naturalBalance(account);
    if (account.kind === LedgerAccountKind.USER_AVAILABLE) entry.available = natural;
    else entry.locked = natural;
    byAsset.set(account.asset, entry);
  }

  if (byAsset.size === 0) {
    return { totalUsd: '0.00', buyingPowerUsd: '0.00', holdings: [] };
  }

  const tokens = await prisma.token.findMany({
    where: { chainId: BASE_CHAIN_ID, symbol: { in: [...byAsset.keys()] } },
    include: { marketData: true },
  });
  const tokenBySymbol = new Map(tokens.map((token) => [token.symbol, token]));

  let total = new Decimal(0);
  let buyingPower = new Decimal(0);
  const holdings: CustodyHolding[] = [];

  for (const [asset, balance] of byAsset) {
    const token = tokenBySymbol.get(asset);
    const isStable = STABLECOINS.has(asset);

    const price = isStable
      ? new Decimal(1)
      : token?.marketData?.priceUsd
        ? new Decimal(token.marketData.priceUsd.toString())
        : null;

    const amount = balance.available.plus(balance.locked);
    const value = price ? amount.times(price) : null;
    if (value) total = total.plus(value);
    if (isStable) buyingPower = buyingPower.plus(balance.available);

    holdings.push({
      asset,
      name: token?.name ?? null,
      available: balance.available.toFixed(),
      locked: balance.locked.toFixed(),
      decimals: token?.decimals ?? null,
      priceUsd: price ? price.toFixed() : null,
      valueUsd: value ? value.toFixed(2) : null,
      complete: value !== null,
    });
  }

  holdings.sort((a, b) => Number(b.valueUsd ?? 0) - Number(a.valueUsd ?? 0));

  return {
    totalUsd: total.toFixed(2),
    buyingPowerUsd: buyingPower.toFixed(2),
    holdings,
  };
}
