import { NextResponse, type NextRequest } from 'next/server';
import { Decimal } from '@/domain/money';
import { newId } from '@/domain/id';
import { jsonError } from '@/server/api';
import { prisma } from '@/server/db';
import { requireAdmin } from '@/server/session';
import { getReferenceRate } from '@/services/execution';
import { allInventoryPositions, rebalanceSuggestions } from '@/services/treasury';

/**
 * Treasury position, limits and rebalancing needs.
 *
 * Admin-only: this is the operator's view of the book, never a customer surface.
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  const requestId = newId();
  try {
    await requireAdmin();

    const [positions, wallets, protocols] = await Promise.all([
      allInventoryPositions(prisma),
      prisma.treasuryWallet.findMany({ orderBy: [{ tier: 'asc' }, { chain: 'asc' }] }),
      prisma.protocol.findMany({ orderBy: { slug: 'asc' } }),
    ]);

    const suggestions = await rebalanceSuggestions(prisma, async (symbol) => {
      if (symbol === 'USD') return new Decimal(1);
      const asset = await prisma.asset.findUnique({ where: { symbol } });
      if (!asset) return new Decimal(0);
      try {
        const { rate } = await getReferenceRate(prisma, {
          asset,
          side: 'SELL',
          amountIn: new Decimal(1),
        });
        return rate;
      } catch {
        return new Decimal(0);
      }
    });

    return NextResponse.json({
      data: {
        inventory: positions.map((p) => ({
          symbol: p.symbol,
          hot: p.hot.toFixed(),
          cold: p.cold.toFixed(),
          total: p.total.toFixed(),
          owedToCustomers: p.owedToCustomers.toFixed(),
          free: p.free.toFixed(),
          short: p.free.isNegative(),
        })),
        rebalance: suggestions.map((s) => ({
          symbol: s.symbol,
          action: s.action,
          freeUsd: s.freeUsd.toFixed(2),
          targetUsd: s.targetUsd.toFixed(2),
          deltaUsd: s.deltaUsd.toFixed(2),
          reason: s.reason,
        })),
        wallets: wallets.map((w) => ({
          tier: w.tier,
          chain: w.chain,
          label: w.label,
          custodian: w.custodian,
          address: w.address,
          maxPerTxUsd: w.maxPerTxUsd.toString(),
          maxDailyOutUsd: w.maxDailyOutUsd.toString(),
          manualApprovalAboveUsd: w.manualApprovalAboveUsd.toString(),
          isActive: w.isActive,
        })),
        protocols: protocols.map((p) => ({
          slug: p.slug,
          name: p.name,
          chain: p.chain,
          kind: p.kind,
          isApproved: p.isApproved,
          isActive: p.isActive,
          maxTradeUsd: p.maxTradeUsd.toString(),
        })),
      },
      requestId,
    });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
