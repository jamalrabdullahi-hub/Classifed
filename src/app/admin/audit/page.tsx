import Link from 'next/link';
import { auditTrail } from '@/services/admin';

export const dynamic = 'force-dynamic';

const QUICK_FILTERS = [
  { label: 'Operator actions', value: 'admin.' },
  { label: 'KYC decisions', value: 'kyc.decided' },
  { label: 'Withdrawals', value: 'withdrawal.' },
  { label: 'Execution', value: 'execution.' },
  { label: 'Security', value: 'security.' },
];

/**
 * The audit trail.
 *
 * Sensitive values are redacted at write time, not at read time — see the
 * REDACTED_KEYS set in services/audit.ts. Nothing on this page can leak a
 * document number, a password hash or a confirmation code, because the row
 * never contained one.
 */
export default async function AdminAudit({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; entityId?: string }>;
}) {
  const { action, entityId } = await searchParams;

  // Exact match only. The quick filters below are prefixes, so they are applied
  // in memory over a recent window rather than pretending to be a full search.
  const isPrefix = Boolean(action?.endsWith('.'));
  const rows = await auditTrail({
    action: isPrefix ? undefined : action,
    entityId,
    take: isPrefix ? 500 : 150,
  });
  const filtered = isPrefix ? rows.filter((r) => r.action.startsWith(action!)) : rows;

  return (
    <>
      <h1>Audit log</h1>

      <div className="inline" style={{ marginBottom: 12 }}>
        <Link className="btn" href="/admin/audit">
          All
        </Link>
        {QUICK_FILTERS.map((f) => (
          <Link
            key={f.value}
            className="btn"
            href={`/admin/audit?action=${encodeURIComponent(f.value)}`}
            style={action === f.value ? { borderColor: 'var(--accent)' } : undefined}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <form method="get" className="inline" style={{ marginBottom: 16 }}>
        <input
          name="entityId"
          defaultValue={entityId ?? ''}
          placeholder="Entity id"
          aria-label="Entity id"
          style={{ minWidth: 260 }}
        />
        <button type="submit">Filter</button>
      </form>

      {filtered.length === 0 ? (
        <p className="muted">No matching entries.</p>
      ) : (
        <div className="scroll">
          <table className="dense">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Change</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td className="muted">
                    {r.createdAt.toISOString().slice(0, 19).replace('T', ' ')}
                  </td>
                  <td>
                    <span className="pill">{r.actorType}</span>
                    {r.actor ? <div className="muted">{r.actor.email}</div> : null}
                  </td>
                  <td className="mono">{r.action}</td>
                  <td className="muted">
                    {r.entityType}
                    {r.entityId ? <div className="mono">{r.entityId.slice(0, 8)}</div> : null}
                  </td>
                  <td className="mono muted" style={{ maxWidth: 320, wordBreak: 'break-all' }}>
                    {r.before ? <div>− {JSON.stringify(r.before)}</div> : null}
                    {r.after ? <div>+ {JSON.stringify(r.after)}</div> : null}
                  </td>
                  <td className="muted mono">{r.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
