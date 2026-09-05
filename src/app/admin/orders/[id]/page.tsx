import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError } from '@/domain/errors';
import { orderDetail } from '@/services/admin';

export const dynamic = 'force-dynamic';

/**
 * One order, and the complete record of where we tried to fill it.
 *
 * This is the best-execution evidence: every venue we asked, what each quoted
 * net of fees, which one we chose, and why the others were rejected. If a
 * customer ever disputes a fill, the answer is on this page.
 */
export default async function AdminOrderDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let detail;
  try {
    detail = await orderDetail(id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const { order, attempts } = detail;
  const chosen = attempts.find((a) => a.status === 'FILLED');

  return (
    <>
      <h1>
        {order.side} {order.asset.symbol}
      </h1>
      <p className="muted mono">{order.id}</p>

      <div className="card">
        <table className="dense">
          <tbody>
            <tr>
              <td className="muted">Customer</td>
              <td>
                <Link href={`/admin/users/${order.user.id}`}>{order.user.email}</Link>
              </td>
            </tr>
            <tr>
              <td className="muted">Status</td>
              <td className={order.status === 'FAILED' ? 'neg' : ''}>{order.status}</td>
            </tr>
            <tr>
              <td className="muted">Requested</td>
              <td>
                ${order.requestedFiatAmount.toString()} for {order.requestedCryptoAmount.toString()}{' '}
                {order.asset.symbol}
              </td>
            </tr>
            <tr>
              <td className="muted">Filled</td>
              <td>
                ${order.filledFiatAmount.toString()} for {order.filledCryptoAmount.toString()}{' '}
                {order.asset.symbol}
              </td>
            </tr>
            {!order.refundedFiatAmount.isZero() ? (
              <tr>
                <td className="muted">Refunded</td>
                <td>${order.refundedFiatAmount.toString()}</td>
              </tr>
            ) : null}
            <tr>
              <td className="muted">Promised floor</td>
              <td>
                {order.minOutputAmount ? (
                  <>
                    {order.minOutputAmount.toString()} {order.asset.symbol}{' '}
                    {order.filledCryptoAmount.gte(order.minOutputAmount) ? (
                      <span className="pos">— honoured</span>
                    ) : order.filledCryptoAmount.isZero() ? (
                      <span className="muted">— not filled</span>
                    ) : (
                      <span className="neg">— BREACHED</span>
                    )}
                  </>
                ) : (
                  '—'
                )}
              </td>
            </tr>
            <tr>
              <td className="muted">Fees</td>
              <td>
                brokerage ${order.brokerageFee.toString()} · provider ${order.providerFee.toString()}
              </td>
            </tr>
            <tr>
              <td className="muted">Venue</td>
              <td>
                {order.executionVenue ?? '—'}
                {order.priceImpactBps !== null ? (
                  <span className="muted"> · {order.priceImpactBps}bp impact</span>
                ) : null}
              </td>
            </tr>
            {order.failureReason ? (
              <tr>
                <td className="muted">Failure</td>
                <td className="neg">{order.failureReason}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <h2>Execution attempts</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        Every venue the router asked, ranked on output net of all fees.{' '}
        {chosen ? `Filled at ${chosen.venueName}.` : 'No venue filled this order.'}
      </p>

      {attempts.length === 0 ? (
        <p className="muted">No attempts recorded.</p>
      ) : (
        <div className="scroll">
          <table className="dense">
            <thead>
              <tr>
                <th>#</th>
                <th>Venue</th>
                <th>Status</th>
                <th className="amount">Quoted</th>
                <th className="amount">Floor</th>
                <th className="amount">Actual</th>
                <th className="amount">Net</th>
                <th className="amount">Impact</th>
                <th className="amount">Gas</th>
                <th>Rejected because</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id}>
                  <td>{a.sequence}</td>
                  <td>
                    <strong>{a.venueName}</strong>
                    <div className="muted">{a.venueKind}</div>
                  </td>
                  <td className={a.status === 'REJECTED' || a.status === 'FAILED' ? 'neg' : 'pos'}>
                    {a.status}
                  </td>
                  <td className="amount">{a.quotedOutput?.toString() ?? '—'}</td>
                  <td className="amount">{a.minOutput?.toString() ?? '—'}</td>
                  <td className="amount">{a.actualOutput?.toString() ?? '—'}</td>
                  <td className="amount">{a.netOutput?.toString() ?? '—'}</td>
                  <td className="amount muted">
                    {a.priceImpactBps === null ? '—' : `${a.priceImpactBps}bp`}
                  </td>
                  <td className="amount muted">
                    {a.gasFeeUsd ? `$${Number(a.gasFeeUsd).toFixed(4)}` : '—'}
                  </td>
                  <td className="muted">{a.failureReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>On-chain swaps</h2>
      {attempts.filter((a) => a.swap).length === 0 ? (
        <p className="muted">This order was filled without touching a chain.</p>
      ) : (
        attempts
          .filter((a) => a.swap)
          .map((a) => {
            const s = a.swap!;
            return (
              <div className="card" key={s.id}>
                <div className="row">
                  <div>
                    <strong>
                      {s.amountIn.toString()} {s.fromSymbol} → {s.toSymbol}
                    </strong>
                    <div className="muted">
                      {s.chain} · floor {s.minAmountOut.toString()} · got{' '}
                      {s.amountOut?.toString() ?? 'nothing'}
                    </div>
                  </div>
                  <div>
                    <span className={s.status === 'CONFIRMED' ? 'pos' : 'neg'}>{s.status}</span>
                  </div>
                </div>
                <div className="muted" style={{ marginTop: 6 }}>
                  {s.privateSubmission ? (
                    <span className="pos">private submission</span>
                  ) : (
                    <span className="neg">public mempool — MEV exposed</span>
                  )}
                  {s.txHash ? <span className="mono"> · {s.txHash}</span> : null}
                  {s.deadline ? ` · deadline ${s.deadline.toISOString().slice(11, 19)}` : null}
                </div>
                {s.failureReason ? <div className="neg">{s.failureReason}</div> : null}
              </div>
            );
          })
      )}

      <p style={{ marginTop: 24 }}>
        <Link className="btn" href="/admin/orders">
          Back to orders
        </Link>
      </p>
    </>
  );
}
