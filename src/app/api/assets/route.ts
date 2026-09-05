import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

/** Public: the tradable universe, driven entirely by the assets table. */
export async function GET(): Promise<NextResponse> {
  const assets = await prisma.asset.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: {
      symbol: true,
      name: true,
      kind: true,
      quoteScale: true,
      network: true,
      tradingEnabled: true,
      withdrawalEnabled: true,
      brokerageFeeBps: true,
      minTradeUsd: true,
      maxTradeUsd: true,
      minWithdrawal: true,
      liquidityTier: true,
      executionMode: true,
      maxDexTradeUsd: true,
    },
  });

  return NextResponse.json({
    data: assets.map((a) => ({
      ...a,
      minTradeUsd: a.minTradeUsd.toString(),
      maxTradeUsd: a.maxTradeUsd.toString(),
      minWithdrawal: a.minWithdrawal.toString(),
      maxDexTradeUsd: a.maxDexTradeUsd.toString(),
    })),
  });
}
