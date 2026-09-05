import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * One guard for the whole operator area.
 *
 * Every /admin page renders inside this layout, so a new page cannot forget the
 * check. The API routes under /api/admin guard themselves independently —
 * this protects the rendered pages, not the data.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'ADMIN') redirect('/dashboard');

  return (
    <div className="admin">
      <nav className="adminnav">
        <Link href="/admin">Overview</Link>
        <Link href="/admin/users">Users</Link>
        <Link href="/admin/kyc">KYC</Link>
        <Link href="/admin/approvals">Approvals</Link>
        <Link href="/admin/deposits">Deposits</Link>
        <Link href="/admin/withdrawals">Withdrawals</Link>
        <Link href="/admin/orders">Orders</Link>
        <Link href="/admin/treasury">Treasury</Link>
        <Link href="/admin/ledger">Ledger</Link>
        <Link href="/admin/reconciliation">Reconcile</Link>
        <Link href="/admin/audit">Audit</Link>
      </nav>
      {children}
    </div>
  );
}
