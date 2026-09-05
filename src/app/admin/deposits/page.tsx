import Link from 'next/link';
import { depositQueue } from '@/services/admin';

export const dynamic = 'force-dynamic';

/**
 * Deposits that are not yet credited, plus recent failures.
 *
 * The gap that matters is CONFIRMED but not CREDITED: the provider says the
 * money arrived and the ledger does not yet reflect it. Anything sitting there
 * is a reconciliation problem, not a waiting customer.
 */
export default async function AdminDeposits() {
  const deposits = await depositQueue();

  return (
    <>
      <h1>Deposits</h1>

      <p className="muted">
        Showing deposits that are not yet credited, plus recent failures. A deposit stuck at
        CONFIRMED means the payment was verified but the ledger has not been posted.
      </p>

      {deposits.length === 0 ? (
        <p className="muted">Nothing in flight.</p>
      ) : (
        <div className="scroll">
          <table className="dense">
            <thead>
              <tr>
                <th>Id</th>
                <th>Customer</th>
                <th>Provider</th>
                <th>Status</th>
                <th className="amount">Gross</th>
                <th className="amount">Fee</th>
                <th className="amount">Net</th>
                <th>Created</th>
                <th>Failure</th>
              </tr>
            </thead>
            <tbody>
              {deposits.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.id.slice(0, 8)}</td>
                  <td>
                    <Link href={`/admin/users/${d.userId}`}>{d.user.email}</Link>
                  </td>
                  <td>
                    {d.provider}
                    <div className="muted">{d.currency}</div>
                  </td>
                  <td className={d.status === 'FAILED' ? 'neg' : ''}>{d.status}</td>
                  <td className="amount">{d.amount.toString()}</td>
                  <td className="amount">{d.providerFee.toString()}</td>
                  <td className="amount">{d.netAmount.toString()}</td>
                  <td className="muted">
                    {d.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="muted">{d.failureReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
