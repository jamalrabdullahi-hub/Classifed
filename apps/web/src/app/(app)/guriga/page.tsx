import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
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
import { custodyPortfolio } from '@flt/core/services/portfolio-usd';
import { OnboardingChecklist } from '@/components/onboarding-checklist';
import { UpgradeBanner } from '@/components/upgrade-banner';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleHome') };
}
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
  const t = await getTranslations('dashboard');
  // Only free accounts are prompted, and the banner itself enforces that too —
  // one forgetful call site should not start nagging paying customers.
  const entitlements = await entitlementsFor(user.id);

  const [kyc, wallets, recentTransactions, portfolio] = await Promise.all([
    prisma.kycProfile.findUnique({ where: { userId: user.id } }),
    prisma.wallet.findMany({
      where: { userId: user.id, verifiedAt: { not: null } },
      include: { chain: { select: { name: true } } },
      orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }],
    }),
    prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { submittedAt: 'desc' },
      take: 5,
    }),
    custodyPortfolio(user.id),
  ]);

  const verified = user.accountStatus === AccountStatus.KYC_APPROVED;
  const canTrade = verified && !user.tradingDisabled && wallets.length > 0;

  return (
    <div className="space-y-8">
      <UpgradeBanner tier={entitlements.tier} reason="general" />

      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[var(--text)]">
          {t('welcomeBack')}
        </h1>
        <p className="mt-1 text-[13px] text-[var(--text-muted)]">{user.email}</p>
      </div>

      <OnboardingChecklist
        kycApproved={kyc?.status === KycStatus.APPROVED}
        balanceUsd={portfolio.totalUsd}
        emailVerified={user.emailVerifiedAt !== null}
      />

      {/* The most important thing on the page is whatever is currently blocking
          the user. Only one of these renders at a time. */}
      {!user.emailVerifiedAt ? (
        <Notice tone="warning" title={t('confirmEmailTitle')}>
          {t('confirmEmailBody')}
          <ResendVerification email={user.email} />
        </Notice>
      ) : !verified ? (
        <VerificationPrompt status={kyc?.status ?? null} reason={kyc?.rejectionReason ?? null} t={t} />
      ) : user.tradingDisabled ? (
        <Notice tone="negative" title={t('tradingDisabledTitle')}>
          {t('tradingDisabledBody')}
        </Notice>
      ) : wallets.length === 0 ? (
        <Notice tone="info" title={t('connectWalletTitle')}>
          {t('connectWalletBody')}
          <div className="mt-3">
            <Button asChild variant="primary" size="sm">
              <Link href="/boorso">
                {t('connectWallet')}
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
              <CardTitle>{t('connectedWallets')}</CardTitle>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link href="/boorso">
                {t('manage')}
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          </CardHeader>

          {wallets.length === 0 ? (
            <EmptyState
              icon={<Wallet className="size-4" />}
              title={t('noWalletConnectedTitle')}
              description={t('noWalletConnectedBody')}
              action={
                <Button asChild variant="primary" size="sm">
                  <Link href="/boorso">{t('connectWallet')}</Link>
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
                    {wallet.isPreferred ? <Badge tone="accent">{t('preferred')}</Badge> : null}
                    <Badge tone="neutral">{wallet.chain.name}</Badge>
                  </div>
                </div>
              ))}
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('account')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3.5">
            <Row
              label={t('verification')}
              value={
                verified ? (
                  <StatusPill tone="neutral">{t('approved')}</StatusPill>
                ) : kyc?.status === KycStatus.IN_REVIEW ? (
                  <StatusPill tone="warning" pulse>
                    {t('inReview')}
                  </StatusPill>
                ) : kyc?.status === KycStatus.REJECTED ? (
                  <StatusPill tone="negative">{t('rejected')}</StatusPill>
                ) : (
                  <StatusPill tone="neutral">{t('notStarted')}</StatusPill>
                )
              }
            />
            <Row
              label={t('email')}
              value={
                user.emailVerifiedAt ? (
                  <StatusPill tone="neutral">{t('confirmed')}</StatusPill>
                ) : (
                  <StatusPill tone="warning">{t('unconfirmed')}</StatusPill>
                )
              }
            />
            <Row
              label={t('trading')}
              value={
                canTrade ? (
                  <StatusPill tone="neutral">{t('enabled')}</StatusPill>
                ) : (
                  <StatusPill tone="neutral">{t('unavailable')}</StatusPill>
                )
              }
            />
            <Row label={t('accountType')} value={<Badge tone="neutral">{user.accountType}</Badge>} />
          </CardContent>
        </Card>
      </div>

      <div>
        <SectionHeader
          title={t('recentActivityTitle')}
          action={
            <Button asChild variant="ghost" size="sm">
              <Link href="/dhaqdhaqaaq">
                {t('viewAll')}
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          }
        />

        <Card className="mt-4">
          {recentTransactions.length === 0 ? (
            <EmptyState
              title={t('noTransactionsTitle')}
              description={t('noTransactionsBody')}
              action={
                canTrade ? (
                  <Button asChild variant="secondary" size="sm">
                    <Link href="/iibso">{t('placeATrade')}</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <CardContent className="divide-y divide-[var(--border)] p-0">
              {recentTransactions.map((transaction) => (
                <Link
                  key={transaction.id}
                  href={`/dhaqdhaqaaq/${transaction.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--text)]">
                      {transaction.kind === 'SWAP' ? t('swap') : t('tokenApproval')}
                    </p>
                    <p className="num mt-0.5 truncate font-mono text-[11px] text-[var(--text-subtle)]">
                      {transaction.txHash}
                    </p>
                  </div>
                  <TransactionStatusPill status={transaction.status} t={t} />
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

function TransactionStatusPill({
  status,
  t,
}: {
  status: string;
  t: Awaited<ReturnType<typeof getTranslations<'dashboard'>>>;
}) {
  if (status === 'CONFIRMED') return <StatusPill tone="neutral">{t('statusConfirmed')}</StatusPill>;
  if (status === 'REVERTED' || status === 'FAILED')
    return (
      <StatusPill tone="negative">
        {status === 'REVERTED' ? t('statusReverted') : t('statusFailed')}
      </StatusPill>
    );
  if (status === 'DROPPED') return <StatusPill tone="warning">{t('statusDropped')}</StatusPill>;
  return (
    <StatusPill tone="info" pulse>
      {t('statusPending')}
    </StatusPill>
  );
}

function VerificationPrompt({
  status,
  reason,
  t,
}: {
  status: KycStatus | null;
  reason: string | null;
  t: Awaited<ReturnType<typeof getTranslations<'dashboard'>>>;
}) {
  if (status === KycStatus.IN_REVIEW) {
    return (
      <Notice tone="info" title={t('reviewTitle')}>
        {t('reviewBody')}
      </Notice>
    );
  }

  if (status === KycStatus.REJECTED) {
    return (
      <Notice tone="negative" title={t('rejectedTitle')}>
        {reason ?? t('rejectedFallback')}
        <div className="mt-3">
          <Button asChild variant="secondary" size="sm">
            <Link href="/xaqiijin">{t('submitAgain')}</Link>
          </Button>
        </div>
      </Notice>
    );
  }

  return (
    <Notice tone="warning" title={t('verifyTitle')} icon={<ShieldCheck className="size-4" />}>
      {t('verifyBody')}
      <div className="mt-3">
        <Button asChild variant="primary" size="sm">
          <Link href="/xaqiijin">
            {t('startVerification')}
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      </div>
    </Notice>
  );
}
