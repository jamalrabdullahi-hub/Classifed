import type { Metadata } from 'next';
import Link from 'next/link';
import { AccountStatus, KycStatus, TransactionStatus, prisma } from '@flt/db';
import { ArrowUpRight, ShieldAlert } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Notice,
  SectionHeader,
  Stat,
  StatusPill,
} from '@flt/ui';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

/**
 * Operator dashboard.
 *
 * Built around work that is waiting rather than around vanity metrics. The
 * first thing an operator should see is what needs a decision today, so the KYC
 * queue and anything flagged lead the page.
 */
export default async function AdminDashboard() {
  await requireAdminPage();

  const [
    userCount,
    pendingKyc,
    suspended,
    tradingDisabled,
    walletCount,
    openTransactions,
    tamperFlags,
    disabledTokens,
    disabledProviders,
    recentActions,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.kycProfile.count({ where: { status: KycStatus.IN_REVIEW } }),
    prisma.user.count({ where: { accountStatus: AccountStatus.SUSPENDED } }),
    prisma.user.count({ where: { tradingDisabled: true } }),
    prisma.wallet.count({ where: { verifiedAt: { not: null } } }),
    prisma.transaction.count({
      where: { status: { in: [TransactionStatus.SUBMITTED, TransactionStatus.PENDING] } },
    }),
    prisma.transaction.count({ where: { tamperDetected: true } }),
    prisma.token.count({ where: { isEnabled: false } }),
    prisma.dexProvider.count({ where: { isEnabled: false } }),
    prisma.adminAction.findMany({
      orderBy: { occurredAt: 'desc' },
      take: 8,
      include: { admin: { select: { email: true } } },
    }),
  ]);

  return (
    <div className="space-y-6">
      <SectionHeader title="Dashboard" description="What needs attention right now." />

      {tamperFlags > 0 ? (
        <Notice
          tone="negative"
          icon={<ShieldAlert className="size-4" />}
          title={`${tamperFlags} transaction${tamperFlags === 1 ? '' : 's'} did not match its quote`}
        >
          The calldata mined on-chain differs from what was quoted. Investigate before assuming a
          client bug.
          <div className="mt-2">
            <Link href="/transactions?flagged=1" className="text-[13px] underline">
              Review flagged transactions
            </Link>
          </div>
        </Notice>
      ) : null}

      {disabledProviders > 0 ? (
        <Notice tone="warning" title="A routing provider is disabled">
          Quoting will fail closed while no provider is available.
        </Notice>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <QueueCard
          label="Awaiting KYC review"
          value={pendingKyc}
          href="/kyc"
          urgent={pendingKyc > 0}
        />
        <QueueCard label="In-flight transactions" value={openTransactions} href="/transactions" />
        <QueueCard label="Suspended accounts" value={suspended} href="/users?status=SUSPENDED" />
        <QueueCard label="Trading disabled" value={tradingDisabled} href="/users" />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent>
            <Stat label="Users" value={userCount} />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Stat label="Verified wallets" value={walletCount} />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Stat label="Disabled tokens" value={disabledTokens} hint="Not tradeable" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent operator actions</CardTitle>
          <Link
            href="/audit"
            className="flex items-center gap-1 text-[13px] link"
          >
            Audit log
            <ArrowUpRight className="size-3.5" />
          </Link>
        </CardHeader>

        {recentActions.length === 0 ? (
          <EmptyState
            title="No operator actions yet"
            description="Every administrative change is recorded here and in the audit log."
          />
        ) : (
          <CardContent className="divide-y divide-[var(--border)] p-0">
            {recentActions.map((action) => (
              <div key={action.id} className="flex items-start justify-between gap-4 px-5 py-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-[var(--text)]">{action.action}</p>
                  <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">
                    {action.admin.email} · {action.entityType}
                    {action.reason ? ` · ${action.reason}` : ''}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-[var(--text-subtle)]">
                  {action.occurredAt.toLocaleString()}
                </span>
              </div>
            ))}
          </CardContent>
        )}
      </Card>
    </div>
  );
}

function QueueCard({
  label,
  value,
  href,
  urgent = false,
}: {
  label: string;
  value: number;
  href: string;
  urgent?: boolean;
}) {
  return (
    <Link href={href}>
      <Card className="transition-colors hover:bg-[var(--surface-hover)]">
        <CardContent className="flex items-center justify-between gap-3">
          <Stat label={label} value={value} />
          {urgent ? <StatusPill tone="warning" pulse>Waiting</StatusPill> : null}
        </CardContent>
      </Card>
    </Link>
  );
}
