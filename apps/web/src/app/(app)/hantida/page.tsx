import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@flt/db';
import { AlertTriangle, Wallet } from 'lucide-react';
import {
  AddressChip,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Notice,
  SectionHeader,
  Stat,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@flt/ui';
import { BASE_CHAIN_ID, explorerAddressUrl, explorerTokenUrl, readBalances } from '@flt/core/chains';
import { Decimal, formatTokenAmount, formatUsd, isNativeToken } from '@flt/core/domain';
import { requireUserPage } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titlePortfolio') };
}
export const dynamic = 'force-dynamic';

/**
 * Portfolio.
 *
 * Balances are read from the chain at request time. There is no mirrored copy
 * in our database to drift out of step — the chain is the only source of truth,
 * and the cost of that honesty is the latency of an RPC round trip.
 *
 * Three kinds of number appear here and the interface keeps them visually
 * distinct, as the brief requires: the on-chain balance (exact), the estimated
 * fiat value (a third-party price, an estimate), and a balance we could not
 * read (unknown, shown as "—" rather than as zero).
 */
export default async function PortfolioPage() {
  const user = await requireUserPage();
  const t = await getTranslations('pages.portfolio');

  const wallets = await prisma.wallet.findMany({
    where: { userId: user.id, verifiedAt: { not: null } },
    orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }],
  });

  if (wallets.length === 0) {
    return (
      <div className="space-y-6">
        <SectionHeader title={t('title')} />
        <Card>
          <EmptyState
            icon={<Wallet className="size-4" />}
            title={t('noWalletTitle')}
            description={t('noWalletBody')}
            action={
              <Button asChild variant="primary" size="sm">
                <Link href="/boorso">{t('connectWallet')}</Link>
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const tokens = await prisma.token.findMany({
    where: { chainId: BASE_CHAIN_ID, isEnabled: true },
    include: { marketData: true },
  });

  const holdings = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const balances = await readBalances(
          wallet.chainId,
          wallet.address,
          tokens
            .filter((token) => !isNativeToken(token.address))
            .map((token) => ({ address: token.address as `0x${string}`, decimals: token.decimals })),
        );
        return { wallet, balances, error: null as string | null };
      } catch (error) {
        // An RPC failure must not blank the page. The wallet is shown with its
        // balances marked unreadable, which is the truth.
        return {
          wallet,
          balances: null,
          error: error instanceof Error ? error.message : 'Could not reach the network',
        };
      }
    }),
  );

  let totalUsd = new Decimal(0);
  let anyUnreadable = false;

  const rows = holdings.flatMap(({ wallet, balances }) => {
    if (!balances) {
      anyUnreadable = true;
      return [];
    }

    const nativeToken = tokens.find((token) => isNativeToken(token.address));
    const entries: {
      walletAddress: string;
      symbol: string;
      name: string;
      address: string;
      decimals: number;
      balance: string;
      readable: boolean;
      priceUsd: string | null;
      valueUsd: Decimal | null;
      tier: string;
    }[] = [];

    if (nativeToken && balances.native.balance !== '0') {
      const value = valueOf(balances.native.balance, nativeToken.decimals, nativeToken.marketData?.priceUsd?.toString() ?? null);
      if (value) totalUsd = totalUsd.plus(value);
      entries.push({
        walletAddress: wallet.address,
        symbol: nativeToken.symbol,
        name: nativeToken.name,
        address: nativeToken.address,
        decimals: nativeToken.decimals,
        balance: balances.native.balance,
        readable: balances.native.ok,
        priceUsd: nativeToken.marketData?.priceUsd?.toString() ?? null,
        valueUsd: value,
        tier: nativeToken.verificationTier,
      });
    }

    for (const balance of balances.tokens) {
      if (balance.balance === '0' && balance.ok) continue;
      const token = tokens.find((entry) => entry.address === balance.tokenAddress);
      if (!token) continue;

      if (!balance.ok) anyUnreadable = true;

      const value = balance.ok
        ? valueOf(balance.balance, token.decimals, token.marketData?.priceUsd?.toString() ?? null)
        : null;
      if (value) totalUsd = totalUsd.plus(value);

      entries.push({
        walletAddress: wallet.address,
        symbol: token.symbol,
        name: token.name,
        address: token.address,
        decimals: token.decimals,
        balance: balance.balance,
        readable: balance.ok,
        priceUsd: token.marketData?.priceUsd?.toString() ?? null,
        valueUsd: value,
        tier: token.verificationTier,
      });
    }

    return entries;
  });

  rows.sort((a, b) => (b.valueUsd?.toNumber() ?? 0) - (a.valueUsd?.toNumber() ?? 0));

  const rpcFailures = holdings.filter((entry) => entry.error);

  return (
    <div className="space-y-6">
      <SectionHeader title={t('title')} description={t('description')} />

      {rpcFailures.length > 0 ? (
        <Notice tone="warning" icon={<AlertTriangle className="size-4" />} title={t('someBalancesTitle')}>
          {t(rpcFailures.length === 1 ? 'networkUnreachableOne' : 'networkUnreachableMany', {
            count: rpcFailures.length,
          })}
        </Notice>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-3">
        <Card>
          <CardContent>
            <Stat
              label={t('estimatedValue')}
              value={formatUsd(totalUsd)}
              hint={anyUnreadable ? t('incompleteHint') : t('thirdPartyPricesHint')}
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Stat label={t('assetsHeld')} value={rows.length} hint={t('nonZeroHint')} />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Stat label={t('wallets')} value={wallets.length} hint={t('linkedVerifiedHint')} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('holdings')}</CardTitle>
          <Badge tone="neutral">Base</Badge>
        </CardHeader>

        {rows.length === 0 ? (
          <EmptyState title={t('noBalancesTitle')} description={t('noBalancesBody')} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>{t('asset')}</TH>
                <TH>{t('contract')}</TH>
                <TH numeric>{t('onChainBalance')}</TH>
                <TH numeric>{t('price')}</TH>
                <TH numeric>{t('estimatedValue')}</TH>
                <TH>{t('wallet')}</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={`${row.walletAddress}-${row.address}`}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.symbol}</span>
                      {row.tier === 'UNVERIFIED' ? <Badge tone="warning">{t('unverified')}</Badge> : null}
                    </div>
                    <span className="text-[11px] text-[var(--text-subtle)]">{row.name}</span>
                  </TD>
                  <TD>
                    <AddressChip
                      address={row.address}
                      explorerUrl={explorerTokenUrl(BASE_CHAIN_ID, row.address)}
                    />
                  </TD>
                  <TD numeric>
                    {row.readable ? (
                      formatTokenAmount(row.balance, row.decimals)
                    ) : (
                      <span className="text-[var(--text-subtle)]" title={t('couldNotBeRead')}>
                        —
                      </span>
                    )}
                  </TD>
                  <TD numeric>{formatUsd(row.priceUsd)}</TD>
                  <TD numeric>
                    {row.valueUsd ? (
                      formatUsd(row.valueUsd)
                    ) : (
                      <span className="text-[var(--text-subtle)]">—</span>
                    )}
                  </TD>
                  <TD>
                    <AddressChip
                      address={row.walletAddress}
                      explorerUrl={explorerAddressUrl(BASE_CHAIN_ID, row.walletAddress)}
                    />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">{t('footerNote')}</p>
    </div>
  );
}

function valueOf(balance: string, decimals: number, priceUsd: string | null): Decimal | null {
  if (!priceUsd) return null;
  try {
    return new Decimal(balance).dividedBy(new Decimal(10).pow(decimals)).times(priceUsd);
  } catch {
    return null;
  }
}
