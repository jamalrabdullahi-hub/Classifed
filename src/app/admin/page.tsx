import Link from 'next/link';
import { queueCounts } from '@/services/admin';
import { reconcile } from '@/services/reconcile';

export const dynamic = 'force-dynamic';

/**
 * What needs a human right now, and whether the books are sound.
 *
 * The reconciliation banner is the most important thing on this page. If the
 * ledger does not balance, nothing else here matters until it does.
 */
export default async function AdminOverview() {
  const [counts, report] = await Promise.all([queueCounts(), reconcile()]);

  const unbalanced = report.ledgerTotals.filter((t) => !t.balanced);
  const insolvent = report.solvency.filter((s) => s.surplus.startsWith('-'));

  return (
    <>
      <h1>Overview</h1>

      {report.healthy ? (
        <p className="ok">
          Books balance across {report.accountsChecked} accounts. No projection drift, no negative
          solvency surplus.
        </p>
      ) : (
        <div className="error">
          <strong>Reconciliation is not healthy.</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {unbalanced.length > 0 ? (
              <li>Unbalanced ledger totals: {unbalanced.map((t) => t.assetSymbol).join(', ')}</li>
            ) : null}
            {insolvent.length > 0 ? (
              <li>Customer liabilities exceed holdings: {insolvent.map((s) => s.assetSymbol).join(', ')}</li>
            ) : null}
            {report.drift.length > 0 ? (
              <li>{report.drift.length} balance projection(s) drifted from the entries</li>
            ) : null}
          </ul>
          <p style={{ margin: '8px 0 0' }}>
            <Link href="/admin/reconciliation">Open reconciliation</Link>
          </p>
        </div>
      )}

      <h2>Waiting on an operator</h2>
      <div className="tiles">
        <Tile href="/admin/kyc" label="KYC to review" n={counts.kycPending} />
        <Tile href="/admin/approvals" label="Approvals pending" n={counts.approvalsPending} />
        <Tile href="/admin/deposits" label="Deposits in flight" n={counts.depositsAwaiting} />
        <Tile href="/admin/withdrawals" label="Withdrawals in flight" n={counts.withdrawalsInFlight} />
        <Tile href="/admin/orders" label="Orders unsettled" n={counts.ordersStuck} />
      </div>

      {report.stuck.length > 0 ? (
        <>
          <h2>Stuck records</h2>
          <p className="muted" style={{ marginTop: -4 }}>
            Records that have sat in a non-terminal state longer than expected. Each one is money
            in an uncertain position.
          </p>
          <div className="scroll">
            <table className="dense">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Id</th>
                  <th>Status</th>
                  <th>Age</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {report.stuck.map((s) => (
                  <tr key={`${s.kind}-${s.id}`}>
                    <td>{s.kind}</td>
                    <td className="mono">{s.id.slice(0, 8)}</td>
                    <td>{s.status}</td>
                    <td className="amount">{s.ageMinutes}m</td>
                    <td className="muted">{s.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h2>Solvency by asset</h2>
      <div className="scroll">
        <table className="dense">
          <thead>
            <tr>
              <th>Asset</th>
              <th className="amount">Owed to customers</th>
              <th className="amount">Held</th>
              <th className="amount">Surplus</th>
            </tr>
          </thead>
          <tbody>
            {report.solvency.map((s) => (
              <tr key={s.assetSymbol}>
                <td>
                  <strong>{s.assetSymbol}</strong>
                </td>
                <td className="amount">{s.owedToCustomers}</td>
                <td className="amount">{s.held}</td>
                <td className={`amount ${s.surplus.startsWith('-') ? 'neg' : 'pos'}`}>{s.surplus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Tile({ href, label, n }: { href: string; label: string; n: number }) {
  return (
    <Link href={href} className={`tile${n > 0 ? ' attn' : ''}`}>
      <div className="n">{n}</div>
      <div className="muted">{label}</div>
    </Link>
  );
}
