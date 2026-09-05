import Link from 'next/link';
import { listUsers } from '@/services/admin';

export const dynamic = 'force-dynamic';

export default async function AdminUsers({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const users = await listUsers({ query: q });

  return (
    <>
      <h1>Users</h1>

      <form method="get" className="inline" style={{ marginBottom: 16 }}>
        <input name="q" defaultValue={q ?? ''} placeholder="Email or phone" aria-label="Search" />
        <button type="submit">Search</button>
        {q ? (
          <Link className="btn" href="/admin/users">
            Clear
          </Link>
        ) : null}
      </form>

      {users.length === 0 ? (
        <p className="muted">No users match.</p>
      ) : (
        <div className="scroll">
          <table className="dense">
            <thead>
              <tr>
                <th>Email</th>
                <th>Phone</th>
                <th>Role</th>
                <th>Status</th>
                <th>KYC</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link href={`/admin/users/${u.id}`}>{u.email}</Link>
                  </td>
                  <td className="muted">{u.phone ?? '—'}</td>
                  <td>{u.role === 'ADMIN' ? <span className="pill">admin</span> : 'customer'}</td>
                  <td className={u.status === 'ACTIVE' ? 'pos' : 'neg'}>{u.status}</td>
                  <td>
                    {u.kycStatus}
                    {u.kycTier > 0 ? <span className="muted"> · tier {u.kycTier}</span> : null}
                  </td>
                  <td className="muted">{u.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
