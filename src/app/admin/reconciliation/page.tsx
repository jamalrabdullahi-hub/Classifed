import Link from 'next/link';
import { reconcile } from '@/services/reconcile';
import { RebuildProjections } from '@/components/admin/RebuildProjections';

export const dynamic = 'force-dynamic';

/**
 * The integrity report. Three independent checks, each of which must hold:
 *
 *  1. Every asset's signed ledger total is exactly zero. Double entry, verified.
 *  2. What customers are owed does not exceed what the business holds.
 *  3. Every cached projection matches a recomputation from the entries.
 *
 * If any fails, the correct response is to stop taking orders and investigate,
 * not to adjust a balance.
 */
export default async function AdminReconciliation() {
  const report = await reconcile();

  return (
    <>
      <h1>Reconciliation</h1>
      <p className="muted">
        Ran {report.ranAt.toISOString().slice(0, 19).replace('T', ' ')} across{' '}
        {report.accountsChecked} accounts.
      </p>

      {report.healthy ? (
        <p className="ok">Healthy. All three checks pass.</p>
      ) : (
        <p className="error">
          Not healthy. Do not resume order flow until the cause is understood — the correct fix is a
          reversing journal entry, never an edit.
        </p>
      )}

      <h2>1 · Ledger totals must be zero</h2>
      <div className="scroll">
        <table className="dense">
          <thead>
            <tr>
              <th>Asset</th>
              <th className="amount">Signed total</th>
              <th>Balanced</th>
            </tr>
          </thead>
          <tbody>
            {report.ledgerTotals.map((t) => (
              <tr key={t.assetSymbol}>
                <td>
                  <strong>{t.assetSymbol}</strong>
                </td>
                <td className="amount">{t.total}</td>
                <td className={t.balanced ? 'pos' : 'neg'}>{t.balanced ? 'yes' : 'NO'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>2 · Solvency</h2>
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
                <td className={`amount ${s.surplus.startsWith('-') ? 'neg' : 'pos'}`}>
                  {s.surplus}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>3 · Projection drift</h2>
      {report.drift.length === 0 ? (
        <p className="muted">No drift. Every cached balance matches the entries.</p>
      ) : (
        <>
          <div className="scroll">
            <table className="dense">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Asset</th>
                  <th className="amount">Projected</th>
                  <th className="amount">Computed</th>
                  <th className="amount">Drift</th>
                </tr>
              </thead>
              <tbody>
                {report.drift.map((d) => (
                  <tr key={d.accountId}>
                    <td className="mono">
                      <Link href={`/admin/ledger/${d.accountId}`}>{d.code}</Link>
                    </td>
                    <td>{d.assetSymbol}</td>
                    <td className="amount">{d.projected}</td>
                    <td className="amount">{d.computed}</td>
                    <td className="amount neg">{d.drift}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12 }}>
            <RebuildProjections />
          </div>
        </>
      )}

      <h2>Stuck records</h2>
      {report.stuck.length === 0 ? (
        <p className="muted">Nothing stuck.</p>
      ) : (
        <div className="scroll">
          <table className="dense">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Id</th>
                <th>Status</th>
                <th className="amount">Age</th>
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
      )}
    </>
  );
}
