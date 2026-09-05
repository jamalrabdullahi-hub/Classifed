import { env } from '@flt/config';
import { AdminShell } from '@/components/shell';
import { requireAdminPage } from '@/server/session';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdminPage();

  return (
    <AdminShell email={admin.email} role={admin.role} environment={env().NODE_ENV}>
      {children}
    </AdminShell>
  );
}
