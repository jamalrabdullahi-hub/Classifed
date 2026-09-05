import { approvalQueue } from '@/services/admin';
import { ApprovalDecision } from '@/components/admin/ApprovalDecision';

export const dynamic = 'force-dynamic';

/**
 * Manual approvals — the gate that large, unusual or first-time-destination
 * withdrawals wait behind before anything leaves a wallet.
 *
 * Highest value at stake first: this queue is a risk queue, not a to-do list.
 */
export default async function AdminApprovals() {
  const [pending, decided] = await Promise.all([approvalQueue('PENDING'), approvalQueue('APPROVED')]);

  const sorted = [...pending].sort((a, b) => {
    const av = a.valueUsd ? Number(a.valueUsd) : 0;
    const bv = b.valueUsd ? Number(b.valueUsd) : 0;
    return bv - av;
  });

  return (
    <>
      <h1>Manual approvals</h1>

      <p className="muted">
        An operator cannot approve a request arising from their own account. Approving here releases
        the underlying action to proceed; it does not itself move funds.
      </p>

      <h2>Pending</h2>
      {sorted.length === 0 ? (
        <p className="muted">Nothing waiting.</p>
      ) : (
        sorted.map((a) => (
          <div className="card" key={a.id}>
            <div className="row">
              <div>
                <strong>{a.entityType}</strong>{' '}
                <span className="mono muted">{a.entityId.slice(0, 8)}</span>
                <div>{a.reason}</div>
                <div className="muted">
                  requested {a.requestedAt.toISOString().slice(0, 16).replace('T', ' ')}
                </div>
              </div>
              <div className="amount">
                {a.valueUsd ? (
                  <strong>${Number(a.valueUsd).toFixed(2)}</strong>
                ) : (
                  <span className="muted">no value</span>
                )}
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <ApprovalDecision approvalId={a.id} />
            </div>
          </div>
        ))
      )}

      <h2>Recently approved</h2>
      {decided.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <div className="scroll">
          <table className="dense">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Reason</th>
                <th className="amount">Value</th>
                <th>Decided</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {decided.slice(0, 25).map((a) => (
                <tr key={a.id}>
                  <td className="mono">
                    {a.entityType} {a.entityId.slice(0, 8)}
                  </td>
                  <td>{a.reason}</td>
                  <td className="amount">{a.valueUsd ? `$${Number(a.valueUsd).toFixed(2)}` : '—'}</td>
                  <td className="muted">{a.decidedAt?.toISOString().slice(0, 16).replace('T', ' ')}</td>
                  <td className="muted">{a.decisionNote ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
