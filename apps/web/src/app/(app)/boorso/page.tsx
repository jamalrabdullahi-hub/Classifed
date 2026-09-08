import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@flt/db';
import { WalletsClient } from './wallets-client';
import { requireUserPage } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleWallets') };
}
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
