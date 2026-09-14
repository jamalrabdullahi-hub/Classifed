import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatUnits } from 'viem';
import { KycStatus, prisma } from '@flt/db';
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, ShieldCheck, Wallet } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Notice,
  StatusPill,
} from '@flt/ui';
import { findChain } from '@flt/core/chains';
import { custodyPortfolio } from '@flt/core/services/portfolio-usd';
import { ResendVerification } from '@/components/resend-verification';
import { requireUserPage } from '@/server/session';
import { ReceiveAddress } from './receive-address';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleHome') };
}

type Tone = 'neutral' | 'positive' | 'warning' | 'negative' | 'info';

interface Movement {
  id: string;
  direction: 'in' | 'out';
  label: string;
  amount: string;
  status: string;
  tone: Tone;
  at: Date;
}

/**
 * The wallet.
 *
 * The account's custodied balances and the three things you do with them: add
 * money, receive to the account's address, and take money out.
 */
export default async function WalletPage() {
  const user = await requireUserPage();

  const t = await getTranslations('custodyWallet');
  const locale = await getLocale();

  const [portfolio, kyc, depositWallet, custodyDeposits, withdrawals, fiatDeposits, fiatWithdrawals] =
    await Promise.all([
      custodyPortfolio(user.id),
      prisma.kycProfile.findUnique({ where: { userId: user.id } }),
      prisma.wallet.findFirst({
        where: { userId: user.id, connector: 'privy-embedded' },
        include: { chain: { select: { name: true } } },
      }),
      prisma.custodyDeposit.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.withdrawal.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.fiatDeposit.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.fiatWithdrawal.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);

  // Token decimals for on-chain amounts, looked up once for every pair shown.
  const pairs = [...custodyDeposits, ...withdrawals].map((row) => ({ chainId: row.chainId, symbol: row.asset }));
  const tokens = pairs.length
    ? await prisma.token.findMany({ where: { OR: pairs }, select: { chainId: true, symbol: true, decimals: true } })
    : [];
  const decimalsFor = (chainId: number, symbol: string) =>
    tokens.find((token) => token.chainId === chainId && token.symbol === symbol)?.decimals;

  const onChainAmount = (chainId: number, symbol: string, baseUnits: string) => {
    const decimals = decimalsFor(chainId, symbol);
    if (decimals === undefined) return symbol;
    const value = Number(formatUnits(BigInt(baseUnits), decimals));
    return `${value.toLocaleString(locale, { maximumFractionDigits: 6 })} ${symbol}`;
  };
  const usd = (value: { toString(): string } | null) =>
    value === null
      ? '—'
      : `$${Number(value.toString()).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const movements: Movement[] = [
    ...custodyDeposits.map((row) => ({
      id: `cd-${row.id}`,
      direction: 'in' as const,
      label: t('movementDeposit', { network: findChain(row.chainId)?.name ?? '' }),
      amount: onChainAmount(row.chainId, row.asset, row.amountBaseUnits),
      status: row.status === 'CREDITED' ? t('statusDone') : row.status === 'FAILED' ? t('statusHeld') : t('statusPending'),
      tone: (row.status === 'CREDITED' ? 'positive' : row.status === 'FAILED' ? 'warning' : 'info') as Tone,
      at: row.createdAt,
    })),
    ...withdrawals.map((row) => ({
      id: `w-${row.id}`,
      direction: 'out' as const,
      label: t('movementSend', { network: findChain(row.chainId)?.name ?? '' }),
      amount: onChainAmount(row.chainId, row.asset, row.amountBaseUnits),
      status:
        row.status === 'COMPLETED' || row.status === 'SENT'
          ? t('statusDone')
          : row.status === 'FAILED'
            ? t('statusFailed')
            : t('statusPending'),
      tone: (row.status === 'COMPLETED' || row.status === 'SENT'
        ? 'positive'
        : row.status === 'FAILED'
          ? 'negative'
          : 'info') as Tone,
      at: row.createdAt,
    })),
    ...fiatDeposits.map((row) => ({
      id: `fd-${row.id}`,
      direction: 'in' as const,
      label: t('movementCashIn', { method: row.method }),
      amount: usd(row.netUsd ?? row.amountFiat),
      status:
        row.status === 'DELIVERED' ? t('statusDone') : row.status === 'REJECTED' ? t('statusFailed') : t('statusPending'),
      tone: (row.status === 'DELIVERED' ? 'positive' : row.status === 'REJECTED' ? 'negative' : 'info') as Tone,
      at: row.createdAt,
    })),
    ...fiatWithdrawals.map((row) => ({
      id: `fw-${row.id}`,
      direction: 'out' as const,
      label: t('movementCashOut', { method: row.method }),
      amount: usd(row.netUsd),
      status: row.status === 'PAID' ? t('statusDone') : row.status === 'REJECTED' ? t('statusFailed') : t('statusPending'),
      tone: (row.status === 'PAID' ? 'positive' : row.status === 'REJECTED' ? 'negative' : 'info') as Tone,
      at: row.createdAt,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 10);

  const total = Number(portfolio.totalUsd);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {!user.emailVerifiedAt ? (
        <Notice tone="warning" title={t('confirmEmailTitle')}>
          {t('confirmEmailBody')}
          <ResendVerification email={user.email} />
        </Notice>
      ) : kyc?.status !== KycStatus.APPROVED ? (
        <Notice
          tone={kyc?.status === KycStatus.REJECTED ? 'negative' : 'info'}
          title={
            kyc?.status === KycStatus.IN_REVIEW
              ? t('kycReviewTitle')
              : kyc?.status === KycStatus.REJECTED
                ? t('kycRejectedTitle')
                : t('kycTitle')
          }
          icon={<ShieldCheck className="size-4" />}
        >
          {kyc?.status === KycStatus.REJECTED ? (kyc.rejectionReason ?? t('kycRejectedBody')) : t('kycBody')}
          {kyc?.status !== KycStatus.IN_REVIEW ? (
            <div className="mt-3">
              <Button asChild variant="secondary" size="sm">
                <Link href="/xaqiijin">{t('kycCta')}</Link>
              </Button>
            </div>
          ) : null}
        </Notice>
      ) : null}

      <Card>
        <CardContent className="space-y-5 pt-6">
          <div>
            <p className="text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--text-subtle)]">
              {t('totalBalance')}
            </p>
            <p className="num mt-1.5 text-[36px] font-semibold tracking-[-0.02em] text-[var(--text)]">
              ${total.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="mt-1 text-[12.5px] text-[var(--text-muted)]">{t('heldForYou')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="primary">
              <Link href="/lacag-gelin">
                <ArrowDownToLine className="size-4" />
                {t('addMoney')}
              </Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/lacag-qaadasho">
                <ArrowUpFromLine className="size-4" />
                {t('withdraw')}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-5 md:grid-cols-5">
        <Card className="md:col-span-3">
          <CardHeader>
            <CardTitle>{t('holdings')}</CardTitle>
          </CardHeader>
          {portfolio.holdings.length === 0 ? (
            <EmptyState
              icon={<Wallet className="size-4" />}
              title={t('emptyTitle')}
              description={t('emptyBody')}
            />
          ) : (
            <CardContent className="divide-y divide-[var(--border)] p-0">
              {portfolio.holdings.map((holding) => (
                <div key={holding.asset} className="flex items-center justify-between gap-4 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium text-[var(--text)]">{holding.asset}</p>
                    <p className="truncate text-[12px] text-[var(--text-subtle)]">{holding.name ?? holding.asset}</p>
                  </div>
                  <div className="text-right">
                    <p className="num text-[14px] text-[var(--text)]">
                      {Number(holding.available).toLocaleString(locale, { maximumFractionDigits: 6 })}
                    </p>
                    <p className="num text-[12px] text-[var(--text-subtle)]">
                      {holding.valueUsd ? usd(holding.valueUsd) : '—'}
                      {Number(holding.locked) > 0
                        ? ` · ${t('reserved', { amount: Number(holding.locked).toLocaleString(locale, { maximumFractionDigits: 6 }) })}`
                        : ''}
                    </p>
                  </div>
                </div>
              ))}
            </CardContent>
          )}
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>{t('receive')}</CardTitle>
          </CardHeader>
          <CardContent>
            {depositWallet ? (
              <ReceiveAddress address={depositWallet.address} network={depositWallet.chain.name} />
            ) : (
              <div className="space-y-3">
                <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">{t('noAddress')}</p>
                <Button asChild variant="secondary" size="sm">
                  <Link href="/lacag-gelin">{t('addMoney')}</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('recent')}</CardTitle>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dhaqdhaqaaq">
              {t('viewAll')}
              <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        </CardHeader>
        {movements.length === 0 ? (
          <EmptyState title={t('noMovementsTitle')} description={t('noMovementsBody')} />
        ) : (
          <CardContent className="divide-y divide-[var(--border)] p-0">
            {movements.map((movement) => (
              <div key={movement.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  {movement.direction === 'in' ? (
                    <ArrowDownToLine className="size-4 shrink-0 text-[var(--positive)]" aria-hidden="true" />
                  ) : (
                    <ArrowUpFromLine className="size-4 shrink-0 text-[var(--text-subtle)]" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-[13px] text-[var(--text)]">{movement.label}</p>
                    <p className="text-[11.5px] text-[var(--text-subtle)]">{movement.at.toLocaleString(locale)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="num text-[13px] text-[var(--text)]">
                    {movement.direction === 'in' ? '+' : '−'}
                    {movement.amount}
                  </span>
                  <StatusPill tone={movement.tone}>{movement.status}</StatusPill>
                </div>
              </div>
            ))}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
