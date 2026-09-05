import Link from 'next/link';
import { ledgerAccounts } from '@/services/admin';

export const dynamic = 'force-dynamic';

/**
 * Every ledger account and its balance, grouped by kind.
 *
 * The balances shown are the projections — a cache. The authoritative number is
 * the sum of the immutable entries, which is what the reconciliation page
 * checks these against.
 */
export default async function AdminLedger() {
  const accounts = await ledgerAccounts();

  const groups = ['ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'EQUITY'] as const;
  const byKind = groups
    .map((kind) => ({ kind, rows: accounts.filter((a) => a.kind === kind) }))
    .filter((g) => g.rows.length > 0);

  const other = accounts.filter((a) => !groups.includes(a.kind as (typeof groups)[number]));
  if (other.length > 0) byKind.push({ kind: 'ASSET', rows: other });

  return (
    <>
      <h1>Ledger</h1>

      <p className="muted">
        Balances here are projections cached from the entries. The entries are immutable and are the
        source of truth — <Link href="/admin/reconciliation">reconciliation</Link> compares the two.
      </p>

      {byKind.map((group) => (
        <div key={group.kind}>
          <h2>{group.kind}</h2>
          <div className="scroll">
            <table className="dense">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Asset</th>
                  <th>Owner</th>
                  <th className="amount">Balance</th>
                  <th className="amount">Entries</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">
                      <Link href={`/admin/ledger/${a.id}`}>{a.code}</Link>
                    </td>
                    <td>{a.symbol}</td>
                    <td className="muted">
                      {a.ownerUserId ? (
                        <Link href={`/admin/users/${a.ownerUserId}`}>
                          {a.ownerUserId.slice(0, 8)}
                        </Link>
                      ) : (
                        'system'
                      )}
                    </td>
                    <td className="amount">{a.balance}</td>
                    <td className="amount muted">{a.entryCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}
