import Link from 'next/link';
import { withdrawalQueue } from '@/services/admin';

export const dynamic = 'force-dynamic';

/**
 * Withdrawals in flight — the highest-risk queue in the system, because it is
 * the only place customer funds leave.
 *
 * SUBMITTED and BROADCAST are the states to watch: the transaction is with the
 * chain or the provider and the outcome is not yet known.
 */
export default async function AdminWithdrawals() {
  const withdrawals = await withdrawalQueue();

  return (
    <>
      <h1>Withdrawals</h1>

      <p className="muted">
        Funds are held on the ledger from CONFIRMED onward, so an in-flight withdrawal cannot be
        spent twice. SUBMITTED and BROADCAST mean the outcome is still unknown — poll before
        retrying anything.
      </p>

      {withdrawals.length === 0 ? (
        <p className="muted">Nothing in flight.</p>
      ) : (
        <div className="scroll">
          <table className="dense">
            <thead>
              <tr>
                <th>Id</th>
                <th>Customer</th>
                <th>Asset</th>
                <th>Status</th>
                <th className="amount">Amount</th>
                <th className="amount">Net out</th>
                <th>Destination</th>
                <th>Tx</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {withdrawals.map((w) => (
                <tr key={w.id}>
                  <td className="mono">{w.id.slice(0, 8)}</td>
                  <td>
                    <Link href={`/admin/users/${w.userId}`}>{w.user.email}</Link>
                  </td>
                  <td>
                    {w.asset?.symbol ?? 'USD'}
                    <div className="muted">{w.kind}</div>
                  </td>
                  <td className={w.status === 'FAILED' ? 'neg' : ''}>
                    {w.status}
                    {w.confirmations > 0 ? (
                      <div className="muted">
                        {w.confirmations}/{w.requiredConfirmations} conf
                      </div>
                    ) : null}
                  </td>
                  <td className="amount">{w.amount.toString()}</td>
                  <td className="amount">{w.netAmount.toString()}</td>
                  <td className="mono" style={{ maxWidth: 160, wordBreak: 'break-all' }}>
                    {w.destinationAddress ?? w.destinationRef ?? '—'}
                  </td>
                  <td className="mono">{w.txHash ? w.txHash.slice(0, 10) : '—'}</td>
                  <td className="muted">
                    {w.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
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
