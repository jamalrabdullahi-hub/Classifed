import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import {
  Badge,
  Card,
  EmptyState,
  SectionHeader,
  StatusPill,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  truncateMiddle,
} from '@flt/ui';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Perpetuals' };
export const dynamic = 'force-dynamic';

/**
 * Perpetual orders and positions, read-only.
 *
 * Orders are what FLT recorded before it contacted the venue (the audit trail),
 * and positions are the venue's own state cached by the worker — each stamped
 * with when it was captured, because a stale liquidation price is worse than
 * none. Read-only: nothing here places or closes anything.
 */

const ORDER_TONE: Record<string, 'positive' | 'info' | 'neutral' | 'negative' | 'warning'> = {
  FILLED: 'positive',
  SUBMITTED: 'info',
  PREPARED: 'neutral',
  CANCELLED: 'neutral',
  REJECTED: 'negative',
};

export default async function PerpsPage() {
  await requireAdminPage();

  const [orders, positions] = await Promise.all([
    prisma.perpOrder.findMany({
      include: {
        user: { select: { email: true } },
        market: { select: { symbol: true } },
      },
      orderBy: { preparedAt: 'desc' },
      take: 100,
    }),
    prisma.perpPositionSnapshot.findMany({
      include: {
        user: { select: { email: true } },
        market: { select: { symbol: true } },
      },
      orderBy: { capturedAt: 'desc' },
      take: 100,
    }),
  ]);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Perpetuals"
        description="Orders FLT placed on the omnibus's venue account, and the positions the venue holds. Read-only."
      />

      <Card>
        <div className="border-b border-[var(--border)] px-4 py-3">
          <p className="text-[13px] font-medium text-[var(--text)]">Orders — last 100</p>
        </div>
        {orders.length === 0 ? (
          <EmptyState title="No perp orders" description="No perpetual orders have been placed." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>User</TH>
                <TH>Market</TH>
                <TH>Kind</TH>
                <TH>Side</TH>
                <TH numeric>Size</TH>
                <TH numeric>Leverage</TH>
                <TH>Status</TH>
                <TH>Venue order</TH>
              </TR>
            </THead>
            <TBody>
              {orders.map((order) => (
                <TR key={order.id}>
                  <TD>
                    <span className="text-[12px] text-[var(--text-muted)]">{order.user.email}</span>
                  </TD>
                  <TD>
                    <span className="text-[13px] text-[var(--text)]">
                      {order.market.symbol}
                      <span className="ml-1 text-[11px] text-[var(--text-subtle)]">
                        {order.venueSlug}
                      </span>
                    </span>
                  </TD>
                  <TD>
                    <Badge tone={order.kind === 'CLOSE' ? 'warning' : 'accent'}>
                      {order.kind.toLowerCase()}
                    </Badge>
                  </TD>
                  <TD>
                    <span className="text-[12px] text-[var(--text)]">
                      {order.side === 'LONG' ? 'Long' : 'Short'}
                    </span>
                  </TD>
                  <TD numeric>
                    <span className="num text-[12px]">{order.size}</span>
                  </TD>
                  <TD numeric>
                    <span className="num text-[12px]">{order.leverage}x</span>
                  </TD>
                  <TD>
                    <StatusPill tone={ORDER_TONE[order.status] ?? 'neutral'}>
                      {order.status.toLowerCase()}
                    </StatusPill>
                  </TD>
                  <TD>
                    <span className="font-mono text-[11px] text-[var(--text-subtle)]">
                      {order.venueOrderId ? truncateMiddle(order.venueOrderId, 12, 6) : '—'}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <div className="border-b border-[var(--border)] px-4 py-3">
          <p className="text-[13px] font-medium text-[var(--text)]">
            Positions — cached from the venue
          </p>
        </div>
        {positions.length === 0 ? (
          <EmptyState
            title="No positions"
            description="No open positions are cached. The worker refreshes these from the venue."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>User</TH>
                <TH>Market</TH>
                <TH>Side</TH>
                <TH numeric>Size</TH>
                <TH numeric>Entry</TH>
                <TH numeric>Margin</TH>
                <TH numeric>uPnL</TH>
                <TH>Captured</TH>
              </TR>
            </THead>
            <TBody>
              {positions.map((position) => (
                <TR key={position.id}>
                  <TD>
                    <span className="text-[12px] text-[var(--text-muted)]">
                      {position.user.email}
                    </span>
                  </TD>
                  <TD>
                    <span className="text-[13px] text-[var(--text)]">
                      {position.market.symbol}
                    </span>
                  </TD>
                  <TD>
                    <span className="text-[12px] text-[var(--text)]">
                      {position.side === 'LONG' ? 'Long' : 'Short'}
                    </span>
                  </TD>
                  <TD numeric>
                    <span className="num text-[12px]">{position.size}</span>
                  </TD>
                  <TD numeric>
                    <span className="num text-[12px]">{position.entryPrice}</span>
                  </TD>
                  <TD numeric>
                    <span className="num text-[12px]">{position.margin}</span>
                  </TD>
                  <TD numeric>
                    <span
                      className="num text-[12px]"
                      style={{
                        color: (position.unrealizedPnl?.startsWith('-') ?? false)
                          ? 'var(--negative)'
                          : 'var(--positive)',
                      }}
                    >
                      {position.unrealizedPnl ?? '—'}
                    </span>
                  </TD>
                  <TD>
                    <span className="text-[11px] text-[var(--text-subtle)]">
                      {position.capturedAt.toLocaleString()}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
