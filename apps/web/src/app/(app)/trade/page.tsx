import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AccountStatus, prisma } from '@flt/db';
import { BASE_CHAIN_ID } from '@flt/core/chains';
import { Button, Notice } from '@flt/ui';
import { MarketPreview } from '@/components/market-preview';
import { TradeClient } from './trade-client';
import { requireUserPage } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleTrade') };
}
export const dynamic = 'force-dynamic';

/**
 * Trade.
 *
 * The gates are checked on the server before the trading interface is rendered
 * at all. Showing a trade panel that cannot produce a quote — and only saying
 * why after the user has picked a pair and typed an amount — wastes their time.
 */
export default async function TradePage() {
  const user = await requireUserPage();
  const t = await getTranslations('tradePage');

  const [tokens, wallets] = await Promise.all([
    prisma.token.findMany({
      where: { isEnabled: true, chainId: BASE_CHAIN_ID, chain: { isEnabled: true } },
      orderBy: [{ verificationTier: 'asc' }, { symbol: 'asc' }],
    }),
    prisma.wallet.findMany({
      where: { userId: user.id, verifiedAt: { not: null } },
      orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }],
    }),
  ]);

  /**
   * A gate blocks trading, not looking.
   *
   * Each of these previously replaced the whole screen with a notice, so a user
   * still being onboarded saw no prices at all on the one page whose job is to
   * show a market. The notice still comes first — it is the thing standing
   * between them and a trade — but the market stays on screen underneath it.
   */
  const previewTokens = tokens.map((token) => ({
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    verificationTier: token.verificationTier,
  }));

  const gate =
    user.accountStatus !== AccountStatus.KYC_APPROVED ? (
      <Notice tone="warning" title={t('verificationRequiredTitle')}>
        {t('verificationRequiredBody')}
        <div className="mt-3">
          <Button asChild variant="primary" size="sm">
            <Link href="/verify">{t('startVerification')}</Link>
          </Button>
        </div>
      </Notice>
    ) : user.tradingDisabled ? (
      <Notice tone="negative" title={t('tradingDisabledTitle')}>
        {t('tradingDisabledBody')}
      </Notice>
    ) : wallets.length === 0 ? (
      <Notice tone="info" title={t('connectWalletTitle')}>
        {t('connectWalletBody')}
        <div className="mt-3">
          <Button asChild variant="primary" size="sm">
            <Link href="/wallets">{t('connectWallet')}</Link>
          </Button>
        </div>
      </Notice>
    ) : null;

  if (gate) {
    return (
      <div className="space-y-5">
        {gate}
        <MarketPreview tokens={previewTokens} />
      </div>
    );
  }

  return (
    <TradeClient
      tokens={tokens.map((token) => ({
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        verificationTier: token.verificationTier,
      }))}
      wallets={wallets.map((wallet) => ({
        id: wallet.id,
        address: wallet.address,
        chainId: wallet.chainId,
        isPreferred: wallet.isPreferred,
      }))}
    />
  );
}
