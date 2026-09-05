import { prisma } from '@flt/db';
import { BASE_CHAIN_ID } from '@flt/core/chains';
import { handler } from '@/server/api';

/**
 * Tradeable tokens.
 *
 * Only enabled tokens on enabled chains. A token an administrator has disabled
 * disappears from the trade screen entirely rather than failing at quote time.
 */
export const GET = handler({}, async () => {
  const tokens = await prisma.token.findMany({
    where: { isEnabled: true, chainId: BASE_CHAIN_ID, chain: { isEnabled: true } },
    orderBy: [{ verificationTier: 'asc' }, { symbol: 'asc' }],
  });

  return tokens.map((token) => ({
    id: token.id,
    chainId: token.chainId,
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    verificationTier: token.verificationTier,
    isNativeWrapper: token.isNativeWrapper,
  }));
});
