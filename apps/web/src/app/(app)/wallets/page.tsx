import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { WalletsClient } from './wallets-client';
import { requireUserPage } from '@/server/session';

export const metadata: Metadata = { title: 'Wallets' };
export const dynamic = 'force-dynamic';

export default async function WalletsPage() {
  const user = await requireUserPage();

  const wallets = await prisma.wallet.findMany({
    where: { userId: user.id },
    orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }],
  });

  return (
    <WalletsClient
      wallets={wallets.map((wallet) => ({
        id: wallet.id,
        address: wallet.address,
        chainId: wallet.chainId,
        isPreferred: wallet.isPreferred,
        connector: wallet.connector,
        verified: wallet.verifiedAt !== null,
        linkedAt: wallet.createdAt.toISOString(),
      }))}
    />
  );
}
