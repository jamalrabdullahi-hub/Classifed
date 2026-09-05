import { prisma } from '@flt/db';
import { listWallets } from '@flt/core/services/wallets';
import { handler } from '@/server/api';

export const GET = handler({}, async ({ user }) => {
  const wallets = await listWallets(prisma, user.id);

  return wallets.map((wallet) => ({
    id: wallet.id,
    address: wallet.address,
    chainId: wallet.chainId,
    label: wallet.label,
    isPreferred: wallet.isPreferred,
    connector: wallet.connector,
    verifiedAt: wallet.verifiedAt?.toISOString() ?? null,
    createdAt: wallet.createdAt.toISOString(),
  }));
});
