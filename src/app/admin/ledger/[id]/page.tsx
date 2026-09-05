import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError } from '@/domain/errors';
import { ledgerEntries } from '@/services/admin';

export const dynamic = 'force-dynamic';

/**
 * The entries behind one account balance.
 *
 * Every row is immutable. A correction appears here as an additional reversing
 * entry, never as a changed row — which is why this page is a complete history
 * rather than a current state.
 */
export default async function AdminLedgerAccount({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data;
  try {
    data = await ledgerEntries(id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const { account, entries } = data;

  return (
    <>
      <h1 className="mono">{account.code}</h1>
      <p className="muted">
        {account.name} · {account.kind} · {account.asset.symbol}
        {account.ownerUserId ? (
          <>
            {' · '}
            <Link href={`/admin/users/${account.ownerUserId}`}>owner</Link>
          </>
        ) : (
          ' · system account'
        )}
      </p>

      <h2>Entries</h2>
      {entries.length === 0 ? (
        <p className="muted">No entries.</p>
      ) : (
        <div className="scroll">
          <table className="dense">
            <thead>
              <tr>
                <th>When</th>
                <th>Transaction</th>
                <th>Type</th>
                <th>Reference</th>
                <th>Dir</th>
                <th className="amount">Amount</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="muted">
                    {e.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="mono">{e.transaction.id.slice(0, 8)}</td>
                  <td>{e.transaction.type}</td>
                  <td className="muted">
                    {e.transaction.referenceType} {e.transaction.referenceId.slice(0, 8)}
                    <div className="muted">{e.transaction.description}</div>
                  </td>
                  <td className={e.direction === 'DEBIT' ? 'pos' : 'neg'}>{e.direction}</td>
                  <td className="amount">{e.amount.toString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ marginTop: 24 }}>
        <Link className="btn" href="/admin/ledger">
          Back to ledger
        </Link>
      </p>
    </>
  );
}
