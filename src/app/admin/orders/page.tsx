import Link from 'next/link';
import { orderList } from '@/services/admin';

export const dynamic = 'force-dynamic';

const STATUSES = [
  'PAID',
  'EXECUTING',
  'PARTIALLY_FILLED',
  'FILLED',
  'SETTLED',
  'FAILED',
  'REFUNDED',
];

export default async function AdminOrders({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const valid = status && STATUSES.includes(status) ? status : undefined;
  const orders = await orderList(valid);

  return (
    <>
      <h1>Orders</h1>

      <div className="inline" style={{ marginBottom: 16 }}>
        <Link className="btn" href="/admin/orders">
          All
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            className="btn"
            href={`/admin/orders?status=${s}`}
            style={valid === s ? { borderColor: 'var(--accent)' } : undefined}
          >
            {s}
          </Link>
        ))}
      </div>

      {orders.length === 0 ? (
        <p className="muted">No orders.</p>
      ) : (
        <div className="scroll">
          <table className="dense">
            <thead>
              <tr>
                <th>Id</th>
                <th>Customer</th>
                <th>Side</th>
                <th>Status</th>
                <th className="amount">USD</th>
                <th className="amount">Filled</th>
                <th>Venue</th>
                <th className="amount">Impact</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="mono">
                    <Link href={`/admin/orders/${o.id}`}>{o.id.slice(0, 8)}</Link>
                  </td>
                  <td>
                    <Link href={`/admin/users/${o.userId}`}>{o.user.email}</Link>
                  </td>
                  <td>
                    {o.side} {o.asset.symbol}
                  </td>
                  <td className={o.status === 'FAILED' ? 'neg' : ''}>{o.status}</td>
                  <td className="amount">{o.requestedFiatAmount.toString()}</td>
                  <td className="amount">{o.filledCryptoAmount.toString()}</td>
                  <td className="muted">{o.executionVenue ?? '—'}</td>
                  <td className="amount muted">
                    {o.priceImpactBps === null ? '—' : `${o.priceImpactBps}bp`}
                  </td>
                  <td className="muted">
                    {o.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
