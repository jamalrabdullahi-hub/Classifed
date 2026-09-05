import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError } from '@/domain/errors';
import { userDetail } from '@/services/admin';
import { KycDecision } from '@/components/admin/KycDecision';
import { UserStatusControl } from '@/components/admin/UserStatusControl';

export const dynamic = 'force-dynamic';

export default async function AdminUserDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let detail;
  try {
    detail = await userDetail(id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const { user, kyc, wallets, balances, deposits, withdrawals, orders } = detail;
  const reviewable = kyc && ['PENDING', 'IN_REVIEW'].includes(kyc.status);

  return (
    <>
      <h1>{user.email}</h1>
      <p className="muted mono">{user.id}</p>

      <div className="card">
        <div className="row">
          <div>
            <div>
              <span className="pill">{user.role}</span>{' '}
              <span className={user.status === 'ACTIVE' ? 'pos' : 'neg'}>{user.status}</span>
            </div>
            <div className="muted">
              {user.phone ?? 'no phone'} · joined {user.createdAt.toISOString().slice(0, 10)}
            </div>
          </div>
          {user.role === 'CUSTOMER' ? (
            <UserStatusControl userId={user.id} status={user.status} />
          ) : null}
        </div>
      </div>

      <h2>Identity</h2>
      {kyc ? (
        <div className="card">
          <table className="dense">
            <tbody>
              <tr>
                <td className="muted">Status</td>
                <td>
                  {kyc.status} · tier {kyc.tier}
                </td>
              </tr>
              <tr>
                <td className="muted">Name</td>
                <td>{kyc.fullName}</td>
              </tr>
              <tr>
                <td className="muted">Born</td>
                <td>{kyc.dateOfBirth.toISOString().slice(0, 10)}</td>
              </tr>
              <tr>
                <td className="muted">Nationality</td>
                <td>{kyc.nationality}</td>
              </tr>
              <tr>
                <td className="muted">Location</td>
                <td>
                  {kyc.city}, {kyc.country}
                </td>
              </tr>
              <tr>
                <td className="muted">Document</td>
                <td>
                  {kyc.documentType}{' '}
                  <span className="muted">
                    — number held encrypted and not shown on any operator screen
                  </span>
                </td>
              </tr>
              <tr>
                <td className="muted">Provider</td>
                <td>{kyc.provider}</td>
              </tr>
              {kyc.rejectionReason ? (
                <tr>
                  <td className="muted">Rejected</td>
                  <td className="neg">{kyc.rejectionReason}</td>
                </tr>
              ) : null}
            </tbody>
          </table>

          {reviewable ? (
            <div style={{ marginTop: 12 }}>
              <KycDecision userId={user.id} />
            </div>
          ) : null}
        </div>
      ) : (
        <p className="muted">No KYC profile submitted.</p>
      )}

      <h2>Balances</h2>
      {balances.length === 0 ? (
        <p className="muted">No ledger accounts yet.</p>
      ) : (
        <div className="scroll">
          <table className="dense">
            <thead>
              <tr>
                <th>Account</th>
                <th>Asset</th>
                <th className="amount">Balance</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.code + b.symbol}>
                  <td className="mono">{b.code}</td>
                  <td>{b.symbol}</td>
                  <td className="amount">{b.balance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>External wallets</h2>
      {wallets.length === 0 ? (
        <p className="muted">None saved.</p>
      ) : (
        wallets.map((w) => (
          <div className="card" key={w.id}>
            <div className="mono" style={{ wordBreak: 'break-all' }}>
              {w.address}
            </div>
            <div className="muted">
              {w.network} · {w.label ?? 'unlabelled'} · added{' '}
              {w.createdAt.toISOString().slice(0, 10)}
            </div>
          </div>
        ))
      )}

      <h2>Orders</h2>
      <RecordTable
        rows={orders.map((o) => ({
          id: o.id,
          href: `/admin/orders/${o.id}`,
          left: `${o.side} ${o.asset.symbol}`,
          middle: o.status,
          right: `$${o.requestedFiatAmount.toString()}`,
          when: o.createdAt,
        }))}
      />

      <h2>Deposits</h2>
      <RecordTable
        rows={deposits.map((d) => ({
          id: d.id,
          left: `${d.currency} ${d.provider}`,
          middle: d.status,
          right: d.amount.toString(),
          when: d.createdAt,
        }))}
      />

      <h2>Withdrawals</h2>
      <RecordTable
        rows={withdrawals.map((w) => ({
          id: w.id,
          left: `${w.kind} ${w.asset?.symbol ?? 'USD'}`,
          middle: w.status,
          right: w.amount.toString(),
          when: w.createdAt,
        }))}
      />

      <p style={{ marginTop: 24 }}>
        <Link className="btn" href="/admin/users">
          Back to users
        </Link>
      </p>
    </>
  );
}

interface Row {
  id: string;
  href?: string;
  left: string;
  middle: string;
  right: string;
  when: Date;
}

function RecordTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p className="muted">None.</p>;
  return (
    <div className="scroll">
      <table className="dense">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">
                {r.href ? <Link href={r.href}>{r.id.slice(0, 8)}</Link> : r.id.slice(0, 8)}
              </td>
              <td>{r.left}</td>
              <td>{r.middle}</td>
              <td className="amount">{r.right}</td>
              <td className="muted">{r.when.toISOString().slice(0, 16).replace('T', ' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
