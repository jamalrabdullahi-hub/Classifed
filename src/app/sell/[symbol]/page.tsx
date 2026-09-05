import { notFound, redirect } from 'next/navigation';
import { TradeForm } from '@/components/TradeForm';
import { prisma } from '@/server/db';
import { currentUser } from '@/server/session';
import { getUserBalances } from '@/services/ledger';

export const dynamic = 'force-dynamic';

export default async function SellPage({ params }: { params: Promise<{ symbol: string }> }) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const { symbol: raw } = await params;
  const symbol = raw.toUpperCase();

  const asset = await prisma.asset.findUnique({ where: { symbol } });
  if (!asset || asset.kind !== 'CRYPTO' || !asset.tradingEnabled) notFound();

  const balances = await getUserBalances(prisma, user.id);
  const usd = balances.find((b) => b.symbol === 'USD');
  const crypto = balances.find((b) => b.symbol === symbol);

  return (
    <TradeForm
      symbol={symbol}
      side="SELL"
      availableUsd={usd ? usd.available.toFixed(2) : '0.00'}
      availableCrypto={crypto ? crypto.available.toFixed(asset.quoteScale) : '0'}
      quoteScale={asset.quoteScale}
    />
  );
}
