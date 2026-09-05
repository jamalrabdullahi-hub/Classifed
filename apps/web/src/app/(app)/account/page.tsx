import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { KeyRound, Monitor, ShieldCheck } from 'lucide-react';
import {
  Badge,
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
import { AccountSecurity } from './account-security';
import { requireUserPage } from '@/server/session';

export const metadata: Metadata = { title: 'Account' };
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

  const [mfa, sessions, devices, kyc] = await Promise.all([
    mfaStatus(prisma, user.id),
    listSessions(prisma, user.id),
    listDevices(prisma, user.id),
    prisma.kycProfile.findUnique({ where: { userId: user.id } }),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <SectionHeader title="Account" description={user.email} />

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-[var(--border)]">
          <DetailRow label="Email" value={user.email} />
          <DetailRow
            label="Email confirmed"
            value={
              user.emailVerifiedAt ? (
                <StatusPill tone="positive">Confirmed</StatusPill>
              ) : (
                <StatusPill tone="warning">Unconfirmed</StatusPill>
              )
            }
          />
          <DetailRow
            label="Identity verification"
            value={<Badge tone="neutral">{kyc?.status ?? 'NOT_STARTED'}</Badge>}
          />
          <DetailRow label="Account type" value={<Badge tone="neutral">{user.accountType}</Badge>} />
          <DetailRow label="Member since" value={user.createdAt.toLocaleDateString()} />
        </CardContent>
      </Card>

      <AccountSecurity
        mfaEnabled={mfa.enabled}
        recoveryCodesRemaining={mfa.recoveryCodesRemaining}
      />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Active sessions</CardTitle>
            <CardDescription>
              Where your account is currently signed in. If you do not recognise one, change your
              password — that revokes every session.
            </CardDescription>
          </div>
          <Badge tone="neutral">{sessions.length}</Badge>
        </CardHeader>

        {sessions.length === 0 ? (
          <EmptyState icon={<Monitor className="size-4" />} title="No active sessions" />
        ) : (
          <CardContent className="space-y-2">
            {sessions.map((session) => (
              <div
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3.5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-[var(--text)]">
                    {describeUserAgent(session.userAgent)}
                  </p>
                  <p className="num mt-0.5 text-[11px] text-[var(--text-subtle)]">
                    {session.ip ?? 'unknown IP'} · last seen{' '}
                    {session.lastSeenAt.toLocaleString()}
                  </p>
                </div>
                <Badge tone="neutral">
                  expires {session.expiresAt.toLocaleTimeString()}
                </Badge>
              </div>
            ))}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Known devices</CardTitle>
            <CardDescription>
              Devices that have signed in to this account, whether or not a session is active.
            </CardDescription>
          </div>
          <Badge tone="neutral">{devices.length}</Badge>
        </CardHeader>

        {devices.length === 0 ? (
          <EmptyState icon={<Monitor className="size-4" />} title="No devices recorded" />
        ) : (
          <CardContent className="space-y-2">
            {devices.map((device) => (
              <div
                key={device.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3.5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-[var(--text)]">
                    {describeUserAgent(device.userAgent)}
                  </p>
                  <p className="num mt-0.5 text-[11px] text-[var(--text-subtle)]">
                    first seen {device.createdAt.toLocaleDateString()} · last seen{' '}
                    {device.lastSeenAt.toLocaleString()}
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
            <CardTitle>What FLT never asks for</CardTitle>
            <CardDescription>
              Nobody legitimate will ever ask you for these — not FLT, not support, not anyone.
            </CardDescription>
          </div>
          <ShieldCheck className="size-4 text-[var(--text-subtle)]" />
        </CardHeader>
        <CardContent>
          <ul className="space-y-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
            {[
              'Your seed phrase or recovery phrase',
              'Your private key',
              'Your wallet password',
              'A signature you did not initiate from this site',
            ].map((item) => (
              <li key={item} className="flex gap-2.5">
                <KeyRound className="mt-0.5 size-3.5 shrink-0 text-[var(--text-subtle)]" />
                {item}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * A readable device description.
 *
 * A raw user agent string is noise to a user trying to answer "is that me?".
 */
function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';

  const browser = /Firefox\//.test(userAgent)
    ? 'Firefox'
    : /Edg\//.test(userAgent)
      ? 'Edge'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser';

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
            : 'Unknown platform';

  return `${browser} on ${platform}`;
}
