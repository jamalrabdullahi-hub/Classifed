import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { prisma } from '@flt/db';
import {
  AddressChip,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DetailRow,
  EmptyState,
  SectionHeader,
  StatusPill,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  truncateMiddle,
} from '@flt/ui';
import { explorerAddressUrl, explorerTxUrl } from '@flt/core/chains';
import { Decimal } from '@flt/core/domain';
import { PERMISSIONS, can } from '@flt/core/services/admin';
import { UserControls } from './user-controls';
import { TierControl } from '@/components/tier-control';
import { SubscriptionControl } from '@/components/subscription-control';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'User' };
export const dynamic = 'force-dynamic';

const CREDIT_KINDS = new Set(['USER_AVAILABLE', 'USER_LOCKED', 'FEE_REVENUE']);

/** The balance as a person states it: liabilities are stored negative. */
function natural(kind: string, balance: string): string {
  const value = new Decimal(balance);
  return (CREDIT_KINDS.has(kind) ? value.negated() : value).toString();
}

/**
 * One user, everything about them.
 *
 * The brief requires an administrator be able to inspect account status,
 * verification state, connected wallet addresses and transaction history from
 * one place, and act on the account. That is this page.
 */
export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminPage();
  const canPrice = can(admin, PERMISSIONS.MANAGE_FEES);
  const canGrantSubscription = can(admin, PERMISSIONS.MANAGE_SUBSCRIPTIONS);
  const { id } = await params;

  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      kycProfile: { include: { decidedBy: { select: { email: true } } } },
      wallets: { orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }] },
      transactions: { orderBy: { submittedAt: 'desc' }, take: 25 },
      subscriptions: {
        where: { status: 'ACTIVE' },
        orderBy: { endsAt: 'desc' },
        take: 1,
      },
      _count: { select: { sessions: true, quotes: true } },
    },
  });

  if (!user) notFound();

  const balances = await prisma.ledgerAccount.findMany({
    where: { userId: id },
    orderBy: [{ asset: 'asc' }, { kind: 'asc' }],
  });

  return (
    <div className="space-y-6">
      <SectionHeader
        title={user.email}
        description={`Account created ${user.createdAt.toLocaleString()}`}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Verification</CardTitle>
              <Badge tone="neutral">{user.kycProfile?.status ?? 'NOT_STARTED'}</Badge>
            </CardHeader>
            <CardContent className="divide-y divide-[var(--border)]">
              <DetailRow
                label="Legal name"
                value={
                  [user.kycProfile?.legalFirstName, user.kycProfile?.legalLastName]
                    .filter(Boolean)
                    .join(' ') || '—'
                }
              />
              <DetailRow label="Country" value={user.kycProfile?.countryCode ?? '—'} />
              <DetailRow
                label="Date of birth"
                value={user.kycProfile?.dateOfBirth?.toLocaleDateString() ?? '—'}
              />
              <DetailRow
                label="Submitted"
                value={user.kycProfile?.submittedAt?.toLocaleString() ?? '—'}
              />
              <DetailRow
                label="Decided"
                value={user.kycProfile?.decidedAt?.toLocaleString() ?? '—'}
                hint={
                  user.kycProfile?.decidedBy?.email
                    ? `by ${user.kycProfile.decidedBy.email}`
                    : undefined
                }
              />
              {user.kycProfile?.rejectionReason ? (
                <DetailRow label="Rejection reason" value={user.kycProfile.rejectionReason} />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Linked wallets</CardTitle>
              <Badge tone="neutral">{user.wallets.length}</Badge>
            </CardHeader>
            {user.wallets.length === 0 ? (
              <EmptyState title="No wallets" description="This user has not linked a wallet." />
            ) : (
              <CardContent className="space-y-2">
                {user.wallets.map((wallet) => (
                  <div
                    key={wallet.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2.5"
                  >
                    <AddressChip
                      address={wallet.address}
                      explorerUrl={explorerAddressUrl(wallet.chainId, wallet.address)}
                    />
                    <div className="flex items-center gap-2">
                      {wallet.isPreferred ? <Badge tone="accent">Preferred</Badge> : null}
                      {wallet.verifiedAt ? (
                        <StatusPill tone="positive">Verified</StatusPill>
                      ) : (
                        <StatusPill tone="neutral">Unlinked</StatusPill>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Custody balances</CardTitle>
              <Badge tone="neutral">{balances.length}</Badge>
            </CardHeader>
            {balances.length === 0 ? (
              <EmptyState title="No balance" description="This account holds nothing in custody." />
            ) : (
              <CardContent className="divide-y divide-[var(--border)]">
                {balances.map((account) => (
                  <DetailRow
                    key={account.id}
                    label={`${account.asset} · ${account.kind.toLowerCase().replace(/_/g, ' ')}`}
                    value={natural(account.kind, account.balance.toString())}
                  />
                ))}
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent transactions</CardTitle>
            </CardHeader>
            {user.transactions.length === 0 ? (
              <EmptyState title="No transactions" description="This user has not traded." />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Type</TH>
                    <TH>Hash</TH>
                    <TH>Status</TH>
                    <TH numeric>Submitted</TH>
                  </TR>
                </THead>
                <TBody>
                  {user.transactions.map((transaction) => (
                    <TR key={transaction.id}>
                      <TD>
                        <Badge tone={transaction.kind === 'SWAP' ? 'accent' : 'neutral'}>
                          {transaction.kind === 'SWAP' ? 'Swap' : 'Approval'}
                        </Badge>
                      </TD>
                      <TD>
                        <a
                          href={explorerTxUrl(transaction.chainId, transaction.txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="num font-mono text-[12px] link"
                        >
                          {truncateMiddle(transaction.txHash, 10, 8)}
                        </a>
                      </TD>
                      <TD>
                        {transaction.tamperDetected ? (
                          <StatusPill tone="negative">Mismatch</StatusPill>
                        ) : transaction.status === 'CONFIRMED' ? (
                          <StatusPill tone="positive">Confirmed</StatusPill>
                        ) : transaction.status === 'REVERTED' ? (
                          <StatusPill tone="negative">Reverted</StatusPill>
                        ) : (
                          <StatusPill tone="info">{transaction.status.toLowerCase()}</StatusPill>
                        )}
                      </TD>
                      <TD numeric>
                        <span className="text-[12px] text-[var(--text-muted)]">
                          {transaction.submittedAt.toLocaleString()}
                        </span>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Account</CardTitle>
            </CardHeader>
            <CardContent className="divide-y divide-[var(--border)]">
              <DetailRow label="Status" value={user.accountStatus.replace(/_/g, ' ')} emphasis />
              <DetailRow
                label="Type"
                value={
                  <span className="flex items-center gap-2">
                    {user.accountType}
                    {canPrice ? (
                      <TierControl userId={user.id} current={user.accountType} />
                    ) : null}
                  </span>
                }
                hint="Pricing tier. Only changes what this account is charged."
              />
              <DetailRow
                label="Email confirmed"
                value={user.emailVerifiedAt ? 'Yes' : 'No'}
              />
              <DetailRow
                label="Plan"
                value={
                  canGrantSubscription ? (
                    <SubscriptionControl
                      userId={user.id}
                      currentTier={user.subscriptions[0]?.tier ?? 'FREE'}
                      currentEndsAt={user.subscriptions[0]?.endsAt?.toISOString() ?? null}
                    />
                  ) : (
                    (user.subscriptions[0]?.tier ?? 'FREE')
                  )
                }
                hint="Entitlements — what this account can do, separate from pricing."
              />
              <DetailRow
                label="Trading approval"
                value={
                  user.tradingApprovedAt
                    ? `Approved ${user.tradingApprovedAt.toLocaleString()}`
                    : 'Not approved'
                }
                hint="The customer's separate trading application."
              />
              <DetailRow
                label="Trading"
                value={user.tradingDisabled ? 'Disabled' : 'Enabled'}
              />
              <DetailRow label="Active sessions" value={user._count.sessions} />
              <DetailRow label="Quotes requested" value={user._count.quotes} />
              <DetailRow
                label="Last sign-in"
                value={user.lastLoginAt?.toLocaleString() ?? 'Never'}
              />
              {user.suspensionReason ? (
                <DetailRow label="Suspension reason" value={user.suspensionReason} />
              ) : null}
            </CardContent>
          </Card>

          <UserControls
            userId={user.id}
            suspended={user.accountStatus === 'SUSPENDED'}
            tradingDisabled={user.tradingDisabled}
            tradingApproved={user.tradingApprovedAt !== null}
            kycApproved={user.accountStatus === 'KYC_APPROVED'}
            canSuspend={can(admin, PERMISSIONS.SUSPEND_USER)}
            canToggleTrading={can(admin, PERMISSIONS.TOGGLE_TRADING)}
          />
        </div>
      </div>
    </div>
  );
}
