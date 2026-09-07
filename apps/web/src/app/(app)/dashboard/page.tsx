import type { Metadata } from 'next';
import Link from 'next/link';
import { AccountStatus, KycStatus, prisma } from '@flt/db';
import { ArrowRight, ArrowUpRight, ShieldCheck, Wallet } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Notice,
  SectionHeader,
  StatusPill,
} from '@flt/ui';
import { explorerAddressUrl } from '@flt/core/chains';
import { AddressChip } from '@flt/ui';
import { ResendVerification } from '@/components/resend-verification';
import { requireUserPage } from '@/server/session';
import { entitlementsFor } from '@flt/core/services/entitlements';
import { UpgradeBanner } from '@/components/upgrade-banner';

export const metadata: Metadata = { title: 'Home' };
export const dynamic = 'force-dynamic';

/**
 * Home.
 *
 * Deliberately a status screen rather than a trading terminal. It answers three
 * questions — can I trade, what is connected, what happened recently — and
 * points at the work. A dashboard full of live prices would encourage exactly
 * the behaviour the brief rules out.
 */
export default async function DashboardPage() {
  const user = await requireUserPage();
  // Only free accounts are prompted, and the banner itself enforces that too —
  // one forgetful call site should not start nagging paying customers.
  const entitlements = await entitlementsFor(user.id);

  const [kyc, wallets, recentTransactions] = await Promise.all([
    prisma.kycProfile.findUnique({ where: { userId: user.id } }),
    prisma.wallet.findMany({
      where: { userId: user.id, verifiedAt: { not: null } },
      orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }],
    }),
    prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { submittedAt: 'desc' },
      take: 5,
    }),
  ]);

  const verified = user.accountStatus === AccountStatus.KYC_APPROVED;
  const canTrade = verified && !user.tradingDisabled && wallets.length > 0;

  return (
    <div className="space-y-8">
      <UpgradeBanner tier={entitlements.tier} reason="general" />

      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[var(--text)]">
          Welcome back
        </h1>
        <p className="mt-1 text-[13px] text-[var(--text-muted)]">{user.email}</p>
      </div>

      {/* The most important thing on the page is whatever is currently blocking
          the user. Only one of these renders at a time. */}
      {!user.emailVerifiedAt ? (
        <Notice tone="warning" title="Confirm your email address">
          A confirmation link was sent when you registered. Your account is limited until it is
          confirmed — if the link never arrived or no longer works, send a new one.
          <ResendVerification email={user.email} />
        </Notice>
      ) : !verified ? (
        <VerificationPrompt status={kyc?.status ?? null} reason={kyc?.rejectionReason ?? null} />
      ) : user.tradingDisabled ? (
        <Notice tone="negative" title="Trading is disabled on this account">
          An administrator has disabled trading. Contact support if you believe this is a mistake.
        </Notice>
      ) : wallets.length === 0 ? (
        <Notice tone="info" title="Connect a wallet to start trading">
          FLT does not hold assets. Link a self-custody wallet and it stays under your control.
          <div className="mt-3">
            <Button asChild variant="primary" size="sm">
              <Link href="/wallets">
                Connect a wallet
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </Notice>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Connected wallets</CardTitle>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link href="/wallets">
                Manage
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          </CardHeader>

          {wallets.length === 0 ? (
            <EmptyState
              icon={<Wallet className="size-4" />}
              title="No wallet connected"
              description="Link a self-custody wallet to view balances and trade. Your keys never leave your device."
              action={
                <Button asChild variant="primary" size="sm">
                  <Link href="/wallets">Connect a wallet</Link>
                </Button>
              }
            />
          ) : (
            <CardContent className="space-y-2.5">
              {wallets.map((wallet) => (
                <div
                  key={wallet.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3.5 py-3"
                >
                  <div className="flex items-center gap-2.5">
                    <Wallet className="size-4 text-[var(--text-subtle)]" aria-hidden="true" />
                    <AddressChip
                      address={wallet.address}
                      explorerUrl={explorerAddressUrl(wallet.chainId, wallet.address)}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {wallet.isPreferred ? <Badge tone="accent">Preferred</Badge> : null}
                    <Badge tone="neutral">Base</Badge>
                  </div>
                </div>
              ))}
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3.5">
            <Row
              label="Verification"
              value={
                verified ? (
                  <StatusPill tone="neutral">Approved</StatusPill>
                ) : kyc?.status === KycStatus.IN_REVIEW ? (
                  <StatusPill tone="warning" pulse>
                    In review
                  </StatusPill>
                ) : kyc?.status === KycStatus.REJECTED ? (
                  <StatusPill tone="negative">Rejected</StatusPill>
                ) : (
                  <StatusPill tone="neutral">Not started</StatusPill>
                )
              }
            />
            <Row
              label="Email"
              value={
                user.emailVerifiedAt ? (
                  <StatusPill tone="neutral">Confirmed</StatusPill>
                ) : (
                  <StatusPill tone="warning">Unconfirmed</StatusPill>
                )
              }
            />
            <Row
              label="Trading"
              value={
                canTrade ? (
                  <StatusPill tone="neutral">Enabled</StatusPill>
                ) : (
                  <StatusPill tone="neutral">Unavailable</StatusPill>
                )
              }
            />
            <Row label="Account type" value={<Badge tone="neutral">{user.accountType}</Badge>} />
          </CardContent>
        </Card>
      </div>

      <div>
        <SectionHeader
          title="Recent activity"
          action={
            <Button asChild variant="ghost" size="sm">
              <Link href="/activity">
                View all
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          }
        />

        <Card className="mt-4">
          {recentTransactions.length === 0 ? (
            <EmptyState
              title="No transactions yet"
              description="Trades you sign will appear here, with their on-chain status and settlement details."
              action={
                canTrade ? (
                  <Button asChild variant="secondary" size="sm">
                    <Link href="/trade">Place a trade</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <CardContent className="divide-y divide-[var(--border)] p-0">
              {recentTransactions.map((transaction) => (
                <Link
                  key={transaction.id}
                  href={`/activity/${transaction.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--text)]">
                      {transaction.kind === 'SWAP' ? 'Swap' : 'Token approval'}
                    </p>
                    <p className="num mt-0.5 truncate font-mono text-[11px] text-[var(--text-subtle)]">
                      {transaction.txHash}
                    </p>
                  </div>
                  <TransactionStatusPill status={transaction.status} />
                </Link>
              ))}
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-[var(--text-muted)]">{label}</span>
      {value}
    </div>
  );
}

function TransactionStatusPill({ status }: { status: string }) {
  if (status === 'CONFIRMED') return <StatusPill tone="neutral">Confirmed</StatusPill>;
  if (status === 'REVERTED' || status === 'FAILED')
    return <StatusPill tone="negative">{status === 'REVERTED' ? 'Reverted' : 'Failed'}</StatusPill>;
  if (status === 'DROPPED') return <StatusPill tone="warning">Dropped</StatusPill>;
  return (
    <StatusPill tone="info" pulse>
      Pending
    </StatusPill>
  );
}

function VerificationPrompt({
  status,
  reason,
}: {
  status: KycStatus | null;
  reason: string | null;
}) {
  if (status === KycStatus.IN_REVIEW) {
    return (
      <Notice tone="info" title="Your verification is being reviewed">
        A member of our compliance team is reviewing your submission. You can connect a wallet and
        browse markets in the meantime.
      </Notice>
    );
  }

  if (status === KycStatus.REJECTED) {
    return (
      <Notice tone="negative" title="Verification was not approved">
        {reason ?? 'Contact support to find out what to do next.'}
        <div className="mt-3">
          <Button asChild variant="secondary" size="sm">
            <Link href="/verify">Submit again</Link>
          </Button>
        </div>
      </Notice>
    );
  }

  return (
    <Notice
      tone="warning"
      title="Verify your identity to start trading"
      icon={<ShieldCheck className="size-4" />}
    >
      Verification is required before you can place a trade.
      <div className="mt-3">
        <Button asChild variant="primary" size="sm">
          <Link href="/verify">
            Start verification
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      </div>
    </Notice>
  );
}
