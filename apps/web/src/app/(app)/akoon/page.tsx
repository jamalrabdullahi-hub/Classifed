import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, getLocale } from 'next-intl/server';
import { prisma } from '@flt/db';
import { KeyRound, Monitor, ShieldCheck, Sparkles } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DetailRow,
  EmptyState,
  SectionHeader,
  StatusPill,
} from '@flt/ui';
import { mfaStatus } from '@flt/core/services/mfa';
import { listDevices, listSessions } from '@flt/core/services/sessions';
import { deletionBlockers } from '@flt/core/services/account-deletion';
import { AccountSecurity } from './account-security';
import { DeleteAccount } from './delete-account';
import { requireUserPage } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleAccount') };
}
export const dynamic = 'force-dynamic';

/**
 * Account and security.
 *
 * Sessions and devices are listed because a user who cannot see where their
 * account is signed in cannot tell whether it has been compromised. Revoking
 * everything is one click away.
 */
export default async function AccountPage() {
  const user = await requireUserPage();
  const t = await getTranslations('pages.account');
  const ta = await getTranslations('accountPage');
  const tn = await getTranslations('nav');
  const tAlgo = await getTranslations('algorithms');
  const locale = await getLocale();

  const [mfa, sessions, devices, kyc] = await Promise.all([
    mfaStatus(prisma, user.id),
    listSessions(prisma, user.id),
    listDevices(prisma, user.id),
    prisma.kycProfile.findUnique({ where: { userId: user.id } }),
  ]);
  const blockers = await deletionBlockers(user.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <SectionHeader title={t('title')} description={user.email} />

      <Card>
        <CardHeader>
          <CardTitle>{ta('profile')}</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-[var(--border)]">
          <DetailRow label={ta('email')} value={user.email} />
          <DetailRow
            label={ta('emailConfirmed')}
            value={
              user.emailVerifiedAt ? (
                <StatusPill tone="positive">{ta('confirmed')}</StatusPill>
              ) : (
                <StatusPill tone="warning">{ta('unconfirmed')}</StatusPill>
              )
            }
          />
          <DetailRow
            label={ta('identityVerification')}
            value={<Badge tone="neutral">{kyc?.status ?? ta('notStarted')}</Badge>}
          />
          <DetailRow label={ta('accountType')} value={<Badge tone="neutral">{user.accountType}</Badge>} />
          <DetailRow label={ta('memberSince')} value={user.createdAt.toLocaleDateString(locale)} />
        </CardContent>
      </Card>

      <AccountSecurity
        mfaEnabled={mfa.enabled}
        recoveryCodesRemaining={mfa.recoveryCodesRemaining}
      />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{ta('activeSessions')}</CardTitle>
            <CardDescription>{ta('activeSessionsDesc')}</CardDescription>
          </div>
          <Badge tone="neutral">{sessions.length}</Badge>
        </CardHeader>

        {sessions.length === 0 ? (
          <EmptyState icon={<Monitor className="size-4" />} title={ta('noActiveSessions')} />
        ) : (
          <CardContent className="space-y-2">
            {sessions.map((session) => (
              <div
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3.5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-[var(--text)]">
                    {describeUserAgent(session.userAgent, ta)}
                  </p>
                  <p className="num mt-0.5 text-[11px] text-[var(--text-subtle)]">
                    {session.ip ?? ta('unknownIp')} ·{' '}
                    {ta('lastSeen', { when: session.lastSeenAt.toLocaleString(locale) })}
                  </p>
                </div>
                <Badge tone="neutral">
                  {ta('expires', { when: session.expiresAt.toLocaleTimeString(locale) })}
                </Badge>
              </div>
            ))}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{ta('knownDevices')}</CardTitle>
            <CardDescription>{ta('knownDevicesDesc')}</CardDescription>
          </div>
          <Badge tone="neutral">{devices.length}</Badge>
        </CardHeader>

        {devices.length === 0 ? (
          <EmptyState icon={<Monitor className="size-4" />} title={ta('noDevicesRecorded')} />
        ) : (
          <CardContent className="space-y-2">
            {devices.map((device) => (
              <div
                key={device.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3.5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-[var(--text)]">
                    {describeUserAgent(device.userAgent, ta)}
                  </p>
                  <p className="num mt-0.5 text-[11px] text-[var(--text-subtle)]">
                    {ta('firstSeenLastSeen', {
                      first: device.createdAt.toLocaleDateString(locale),
                      last: device.lastSeenAt.toLocaleString(locale),
                    })}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{tn('autoTrading')}</CardTitle>
            <CardDescription>{tAlgo('description')}</CardDescription>
          </div>
          <Sparkles className="size-4 text-[var(--text-subtle)]" />
        </CardHeader>
        <CardContent>
          <Button asChild variant="secondary">
            <Link href="/ganacsi-otomaatig">{tn('autoTrading')}</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{ta('neverAsksTitle')}</CardTitle>
            <CardDescription>{ta('neverAsksDesc')}</CardDescription>
          </div>
          <ShieldCheck className="size-4 text-[var(--text-subtle)]" />
        </CardHeader>
        <CardContent>
          <ul className="space-y-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
            {[ta('seedPhrase'), ta('privateKey'), ta('walletPassword'), ta('unsolicitedSignature')].map(
              (item) => (
                <li key={item} className="flex gap-2.5">
                  <KeyRound className="mt-0.5 size-3.5 shrink-0 text-[var(--text-subtle)]" />
                  {item}
                </li>
              ),
            )}
          </ul>
        </CardContent>
      </Card>

      <Card id="trading" className="scroll-mt-20">
        <CardHeader>
          <div>
            <CardTitle>{ta('tradingTitle')}</CardTitle>
            <CardDescription>{ta('tradingDesc')}</CardDescription>
          </div>
          {kyc?.status === 'APPROVED' && user.tradingApprovedAt ? (
            <StatusPill tone="positive">{ta('tradingEnabled')}</StatusPill>
          ) : kyc?.status === 'APPROVED' ? (
            <StatusPill tone="warning">{ta('tradingAwaitingApproval')}</StatusPill>
          ) : kyc?.status === 'IN_REVIEW' ? (
            <StatusPill tone="warning">{ta('tradingInReview')}</StatusPill>
          ) : (
            <StatusPill tone="neutral">{ta('tradingOff')}</StatusPill>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="ml-4 list-decimal space-y-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
            <li>{ta('tradingStep1')}</li>
            <li>{ta('tradingStep2')}</li>
            <li>{ta('tradingStep3')}</li>
          </ol>
          {kyc?.status !== 'APPROVED' && kyc?.status !== 'IN_REVIEW' ? (
            <Button asChild variant="secondary">
              <Link href="/xaqiijin">{ta('tradingApply')}</Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <DeleteAccount blockers={blockers} />
    </div>
  );
}

/**
 * A readable device description.
 *
 * A raw user agent string is noise to a user trying to answer "is that me?".
 */
function describeUserAgent(
  userAgent: string | null,
  ta: Awaited<ReturnType<typeof getTranslations<'accountPage'>>>,
): string {
  if (!userAgent) return ta('unknownDevice');

  const browser = /Firefox\//.test(userAgent)
    ? 'Firefox'
    : /Edg\//.test(userAgent)
      ? 'Edge'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : ta('browserGeneric');

  const platform = /Windows/.test(userAgent)
    ? 'Windows'
    : /Macintosh|Mac OS/.test(userAgent)
      ? 'macOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /iPhone|iPad/.test(userAgent)
          ? 'iOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : ta('unknownPlatform');

  return ta('browserOnPlatform', { browser, platform });
}
