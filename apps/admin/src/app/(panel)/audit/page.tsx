import type { Metadata } from 'next';
import { prisma, type Prisma } from '@flt/db';
import {
  Badge,
  Card,
  EmptyState,
  Input,
  SectionHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@flt/ui';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

/**
 * The audit log.
 *
 * Append-only, and never edited from this interface — there is deliberately no
 * delete or amend control anywhere on this page. An audit trail an operator can
 * alter is not an audit trail.
 *
 * Before/after payloads run through the redaction pass on write, so secrets do
 * not reach this view even if a caller passed one.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; entity?: string }>;
}) {
  await requireAdminPage();
  const params = await searchParams;

  const where: Prisma.AuditLogWhereInput = {
    ...(params.action ? { action: { contains: params.action, mode: 'insensitive' as const } } : {}),
    ...(params.entity ? { entityType: { equals: params.entity } } : {}),
  };

  const entries = await prisma.auditLog.findMany({
    where,
    orderBy: { occurredAt: 'desc' },
    take: 200,
  });

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Audit log"
        description="Every authentication event, account change, trade and operator action. Append-only — entries cannot be edited or removed."
      />

      <form method="get" className="flex flex-wrap gap-2">
        <Input
          name="action"
          defaultValue={params.action ?? ''}
          placeholder="Filter by action, e.g. admin.user"
          className="min-w-0 flex-1"
          aria-label="Filter by action"
        />
        <Input
          name="entity"
          defaultValue={params.entity ?? ''}
          placeholder="Entity type"
          className="w-40"
          aria-label="Filter by entity type"
        />
        <button
          type="submit"
          className="rounded-[var(--radius-md)] bg-[var(--accent)] px-4 text-[13px] font-medium text-white"
        >
          Filter
        </button>
      </form>

      <Card>
        {entries.length === 0 ? (
          <EmptyState title="No entries" description="Nothing matches those filters." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH numeric>When</TH>
                <TH>Actor</TH>
                <TH>Action</TH>
                <TH>Entity</TH>
                <TH>Detail</TH>
              </TR>
            </THead>
            <TBody>
              {entries.map((entry) => (
                <TR key={entry.id}>
                  <TD numeric>
                    <span className="text-[12px] text-[var(--text-muted)]">
                      {entry.occurredAt.toLocaleString()}
                    </span>
                  </TD>
                  <TD>
                    <Badge
                      tone={
                        entry.actorType === 'ADMIN'
                          ? 'accent'
                          : entry.actorType === 'USER'
                            ? 'neutral'
                            : 'info'
                      }
                    >
                      {entry.actorType}
                    </Badge>
                  </TD>
                  <TD>
                    <code className="font-mono text-[12px] text-[var(--text)]">{entry.action}</code>
                  </TD>
                  <TD>
                    <span className="text-[12px] text-[var(--text-muted)]">{entry.entityType}</span>
                  </TD>
                  <TD>
                    <details className="max-w-md">
                      <summary className="cursor-pointer text-[12px] text-[var(--accent)]">
                        View
                      </summary>
                      <pre className="scroll-x mt-2 rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] p-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
                        {JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}
                      </pre>
                    </details>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
