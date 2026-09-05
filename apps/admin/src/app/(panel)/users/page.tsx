import type { Metadata } from 'next';
import Link from 'next/link';
import { AccountStatus, prisma, type Prisma } from '@flt/db';
import { Search } from 'lucide-react';
import {
  Badge,
  Card,
  EmptyState,
  Input,
  SectionHeader,
  StatusPill,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@flt/ui';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Users' };
export const dynamic = 'force-dynamic';

/**
 * User search.
 *
 * A server-rendered form rather than a live-filtering client component: the
 * query lands in the URL, so an operator can share a link to exactly what they
 * were looking at when they escalate something.
 */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  await requireAdminPage();
  const params = await searchParams;

  const query = params.q?.trim() ?? '';
  const status = params.status;

  const where: Prisma.UserWhereInput = {
    ...(query ? { email: { contains: query, mode: 'insensitive' as const } } : {}),
    ...(status && status in AccountStatus
      ? { accountStatus: status as AccountStatus }
      : {}),
  };

  const users = await prisma.user.findMany({
    where,
    include: {
      kycProfile: { select: { status: true } },
      _count: { select: { wallets: true, transactions: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Users"
        description="Search by email address. Select a user to inspect their wallets, transactions and verification state."
      />

      <form method="get" className="flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--text-subtle)]" />
          <Input
            name="q"
            defaultValue={query}
            placeholder="Search by email"
            className="pl-8"
            aria-label="Search users by email"
          />
        </div>

        <select
          name="status"
          defaultValue={status ?? ''}
          className="rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--text)]"
          aria-label="Filter by account status"
        >
          <option value="">All statuses</option>
          {Object.values(AccountStatus).map((value) => (
            <option key={value} value={value}>
              {value.replace(/_/g, ' ')}
            </option>
          ))}
        </select>

        <button
          type="submit"
          className="rounded-[var(--radius-md)] bg-[var(--accent)] px-4 text-[13px] font-medium text-white"
        >
          Search
        </button>
      </form>

      <Card>
        {users.length === 0 ? (
          <EmptyState
            title="No users found"
            description={query ? `Nothing matches "${query}".` : 'No accounts yet.'}
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Email</TH>
                <TH>Account status</TH>
                <TH>Verification</TH>
                <TH>Trading</TH>
                <TH numeric>Wallets</TH>
                <TH numeric>Transactions</TH>
                <TH numeric>Joined</TH>
              </TR>
            </THead>
            <TBody>
              {users.map((user) => (
                <TR key={user.id}>
                  <TD>
                    <Link
                      href={`/users/${user.id}`}
                      className="text-[13px] text-[var(--accent)] hover:underline"
                    >
                      {user.email}
                    </Link>
                  </TD>
                  <TD>
                    <AccountBadge status={user.accountStatus} />
                  </TD>
                  <TD>
                    <Badge tone="neutral">{user.kycProfile?.status ?? 'NOT_STARTED'}</Badge>
                  </TD>
                  <TD>
                    {user.tradingDisabled ? (
                      <StatusPill tone="negative">Disabled</StatusPill>
                    ) : (
                      <StatusPill tone="positive">Enabled</StatusPill>
                    )}
                  </TD>
                  <TD numeric>{user._count.wallets}</TD>
                  <TD numeric>{user._count.transactions}</TD>
                  <TD numeric>
                    <span className="text-[12px] text-[var(--text-muted)]">
                      {user.createdAt.toLocaleDateString()}
                    </span>
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

function AccountBadge({ status }: { status: AccountStatus }) {
  if (status === AccountStatus.KYC_APPROVED) return <StatusPill tone="positive">Approved</StatusPill>;
  if (status === AccountStatus.SUSPENDED) return <StatusPill tone="negative">Suspended</StatusPill>;
  if (status === AccountStatus.KYC_REJECTED) return <StatusPill tone="negative">Rejected</StatusPill>;
  if (status === AccountStatus.KYC_REVIEW) return <StatusPill tone="warning">In review</StatusPill>;
  return <StatusPill tone="neutral">{status.replace(/_/g, ' ').toLowerCase()}</StatusPill>;
}
