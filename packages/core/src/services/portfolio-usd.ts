import { prisma } from '@flt/db';
import { Decimal } from '../domain/money';
import { readBalances } from '../chains/balances';
import { SUPPORTED_CHAINS } from '../chains/registry';

/**
 * A combined USD figure across every wallet FLT knows about — the auto-
 * provisioned embedded wallet and any manually linked ones — so a
 * low-information user can see "how much can I trade with" without knowing
 * which chain or token their balance happens to sit in.
 *
 * Display only. Trading itself still executes on whichever specific
 * chain/wallet actually holds the funds — this does not move, bridge, or
 * convert anything. See the "screw that, just autoconvert" conversation this
 * came out of: the heavier version (auto-bridge funds behind the scenes to
 * execute a trade) is a real, separate cross-chain integration, not this.
 *
 * A stablecoin balance is treated as worth exactly $1 per unit. That is the
 * assumption every part of this platform's fee and pricing code already
 * makes about USDC/USDT (see e.g. Subscription.pricePaidUsd), not a new one
 * introduced here.
 */

/** Symbols treated as USD-equivalent for this summary. Case-sensitive; must match the seeded Token.symbol exactly. */
const USD_SYMBOLS = new Set(['USDC', 'USDT']);

export interface ChainUsdBalance {
  chainId: number;
  chainName: string;
  usd: string;
  /** False if any token read on this chain failed — the total may understate. */
  complete: boolean;
}

export interface UsdBalanceSummary {
  totalUsd: string;
  chains: ChainUsdBalance[];
  /** Wallets FLT holds an address for but cannot read a balance on yet. */
  unsupportedChainIds: number[];
}

export async function usdBalanceSummary(userId: string): Promise<UsdBalanceSummary> {
  const wallets = await prisma.wallet.findMany({ where: { userId } });
  if (wallets.length === 0) {
    return { totalUsd: '0', chains: [], unsupportedChainIds: [] };
  }

  const chainIds = [...new Set(wallets.map((wallet) => wallet.chainId))];
  const supportedChainIds = new Set(SUPPORTED_CHAINS.map((chain) => chain.chainId));
  const unsupportedChainIds = chainIds.filter((id) => !supportedChainIds.has(id));

  const stablecoins = await prisma.token.findMany({
    where: { chainId: { in: chainIds }, symbol: { in: [...USD_SYMBOLS] }, isEnabled: true },
  });

  const chainResults = await Promise.all(
    SUPPORTED_CHAINS.filter((chain) => chainIds.includes(chain.chainId)).map(
      async (chain): Promise<ChainUsdBalance> => {
        const walletsOnChain = wallets.filter((wallet) => wallet.chainId === chain.chainId);
        const tokensOnChain = stablecoins.filter((token) => token.chainId === chain.chainId);

        if (tokensOnChain.length === 0 || walletsOnChain.length === 0) {
          return { chainId: chain.chainId, chainName: chain.name, usd: '0', complete: true };
        }

        let usd = new Decimal(0);
        let complete = true;

        for (const wallet of walletsOnChain) {
          try {
            const result = await readBalances(
              chain.chainId,
              wallet.address,
              tokensOnChain.map((token) => ({ address: token.address as `0x${string}`, decimals: token.decimals })),
            );
            for (const tokenBalance of result.tokens) {
              if (!tokenBalance.ok) {
                complete = false;
                continue;
              }
              const token = tokensOnChain.find(
                (each) => each.address.toLowerCase() === tokenBalance.tokenAddress.toLowerCase(),
              );
              if (!token) continue;
              usd = usd.plus(new Decimal(tokenBalance.balance).div(new Decimal(10).pow(token.decimals)));
            }
          } catch {
            complete = false;
          }
        }

        return { chainId: chain.chainId, chainName: chain.name, usd: usd.toFixed(2), complete };
      },
    ),
  );

  const totalUsd = chainResults
    .reduce((sum, chain) => sum.plus(new Decimal(chain.usd)), new Decimal(0))
    .toFixed(2);

  return { totalUsd, chains: chainResults, unsupportedChainIds };
}
