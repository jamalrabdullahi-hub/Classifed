import { redirect } from 'next/navigation';
import { WithdrawForm } from '@/components/WithdrawForm';
import { prisma } from '@/server/db';
import { currentUser } from '@/server/session';
import { getUserBalances } from '@/services/ledger';

export const dynamic = 'force-dynamic';

export default async function WithdrawPage({
  searchParams,
}: {
  searchParams: Promise<{ asset?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const { asset: requested } = await searchParams;

  const [balances, assetRows, wallets] = await Promise.all([
    getUserBalances(prisma, user.id),
    prisma.asset.findMany({
      where: { kind: 'CRYPTO', isActive: true, withdrawalEnabled: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.wallet.findMany({
      where: { userId: user.id, isActive: true },
      include: { asset: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const assets = assetRows.map((a) => {
    const balance = balances.find((b) => b.symbol === a.symbol);
    return {
      symbol: a.symbol,
      quoteScale: a.quoteScale,
      available: balance ? balance.available.toFixed(a.quoteScale) : '0',
      minWithdrawal: a.minWithdrawal.toString(),
    };
  });

  const initial =
    assets.find((a) => a.symbol === requested?.toUpperCase())?.symbol ??
    assets[0]?.symbol ??
    'BTC';

  return (
    <WithdrawForm
      assets={assets}
      initialSymbol={initial}
      wallets={wallets.map((w) => ({
        id: w.id,
        assetSymbol: w.asset.symbol,
        network: w.network,
        address: w.address,
        label: w.label,
      }))}
    />
  );
}
