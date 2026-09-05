import type { Metadata } from 'next';
import Link from 'next/link';
import { AccountStatus, prisma } from '@flt/db';
import { BASE_CHAIN_ID } from '@flt/core/chains';
import { Button, Notice } from '@flt/ui';
import { TradeClient } from './trade-client';
import { requireUserPage } from '@/server/session';

export const metadata: Metadata = { title: 'Trade' };
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

  if (user.accountStatus !== AccountStatus.KYC_APPROVED) {
    return (
      <Notice tone="warning" title="Verification required">
        Your identity must be verified before you can trade.
        <div className="mt-3">
          <Button asChild variant="primary" size="sm">
            <Link href="/verify">Start verification</Link>
          </Button>
        </div>
      </Notice>
    );
  }

  if (user.tradingDisabled) {
    return (
      <Notice tone="negative" title="Trading is disabled on this account">
        An administrator has disabled trading. Contact support if you believe this is a mistake.
      </Notice>
    );
  }

  if (wallets.length === 0) {
    return (
      <Notice tone="info" title="Connect a wallet to trade">
        FLT does not hold assets. Link a self-custody wallet and it stays under your control.
        <div className="mt-3">
          <Button asChild variant="primary" size="sm">
            <Link href="/wallets">Connect a wallet</Link>
          </Button>
        </div>
      </Notice>
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
