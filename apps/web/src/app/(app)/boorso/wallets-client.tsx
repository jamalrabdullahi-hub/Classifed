'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Plus, Star, Unlink, Wallet } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AddressChip,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Notice,
  SectionHeader,
  StatusPill,
} from '@flt/ui';
import { WalletConnectDialog } from '@/components/wallet-connect';
import { FltWalletCard } from '@/components/flt-wallet-card';
import { ApiError, apiFetch, del, get } from '@/lib/api';

interface CustodyHolding {
  asset: string;
  name: string | null;
  available: string;
  locked: string;
  priceUsd: string | null;
  valueUsd: string | null;
  complete: boolean;
}

interface CustodyPortfolio {
  totalUsd: string;
  buyingPowerUsd: string;
  holdings: CustodyHolding[];
}

/**
 * The account's balance, from the custody ledger — the participant's total
 * value and what is spendable right now. Display only; see `custodyPortfolio`.
 */
function UsdBalanceSummaryCard() {
  const t = useTranslations('walletsPage');
  const [summary, setSummary] = useState<CustodyPortfolio | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    get<CustodyPortfolio>('/api/wallets/usd-balance')
      .then((result) => {
        if (!cancelled) setSummary(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return null;

  return (
    <Card>
      <CardContent className="space-y-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
            {t('totalBalanceLabel')}
          </p>
          <p className="num text-[28px] font-semibold tabular-nums text-[var(--text)]">
            {summary ? `$${summary.totalUsd}` : '—'}
          </p>
          <p className="mt-1 text-[11px] text-[var(--text-subtle)]">{t('totalBalanceHint')}</p>
        </div>
        {summary ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
            <span className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-1 text-[11px] text-[var(--text-muted)]">
              {t('buyingPowerLabel')}:{' '}
              <span className="num tabular-nums text-[var(--text)]">${summary.buyingPowerUsd}</span>
            </span>
            {summary.holdings.map((holding) => (
              <span
                key={holding.asset}
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-1 text-[11px] text-[var(--text-muted)]"
              >
                {holding.asset}:{' '}
                <span className="num tabular-nums text-[var(--text)]">
                  {holding.valueUsd ? `$${holding.valueUsd}` : '—'}
                </span>
                {!holding.complete ? ' *' : ''}
              </span>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export interface WalletSummary {
  id: string;
  address: string;
  chainId: number;
  isPreferred: boolean;
  connector: string | null;
  verified: boolean;
  linkedAt: string;
}

const EXPLORER = 'https://basescan.org';

/**
 * Wallets.
 *
 * The page states the custody model at the top rather than assuming the user
 * remembers it from onboarding. Someone arriving here is about to grant an
 * association between an on-chain identity and an account, and the honest thing
 * is to say what that does and does not mean, every time.
 */
export function WalletsClient({ wallets }: { wallets: WalletSummary[] }) {
  const router = useRouter();
  const t = useTranslations('walletsPage');
  const locale = useLocale();
  const [connectOpen, setConnectOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function makePreferred(id: string) {
    setError(null);
    setBusyId(id);
    try {
      await apiFetch(`/api/wallets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isPreferred: true }),
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('updateError'));
    } finally {
      setBusyId(null);
    }
  }

  async function unlink(id: string) {
    setError(null);
    setBusyId(id);
    try {
      await del(`/api/wallets/${id}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('unlinkError'));
    } finally {
      setBusyId(null);
    }
  }

  // The EVM row is the one worth showing: Base and BNB share an address, and
  // the Solana row is a different address the trade screens cannot use yet.
  const fltWallet = wallets.find((wallet) => wallet.connector === 'privy-embedded');

  const linked = wallets.filter((wallet) => wallet.verified);
  const unlinked = wallets.filter((wallet) => !wallet.verified);

  return (
    <div className="space-y-6">
      <SectionHeader
        title={t('title')}
        description={t('description')}
        action={
          <Button variant="primary" size="sm" onClick={() => setConnectOpen(true)}>
            <Plus className="size-3.5" />
            {t('connectWallet')}
          </Button>
        }
      />

      {/* Above the linked-wallet list: for somebody with no wallet at all,
          this is the path that does not require installing anything. */}
      <FltWalletCard
        hasFltWallet={fltWallet !== undefined}
        address={fltWallet?.address ?? null}
      />

      <UsdBalanceSummaryCard />

      {error ? <Notice tone="negative">{error}</Notice> : null}

      {linked.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Wallet className="size-4" />}
            title={t('noWalletTitle')}
            description={t('noWalletBody')}
            action={
              <Button variant="primary" size="sm" onClick={() => setConnectOpen(true)}>
                {t('connectWallet')}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {linked.map((wallet) => (
            <Card key={wallet.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)]">
                    <Wallet className="size-4 text-[var(--text-muted)]" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <AddressChip
                        address={wallet.address}
                        explorerUrl={`${EXPLORER}/address/${wallet.address}`}
                      />
                      {wallet.isPreferred ? (
                        <Badge tone="accent">
                          <Star className="size-2.5" />
                          {t('preferred')}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1.5 text-[11px] text-[var(--text-subtle)]">
                      {t('linkedOn', { date: new Date(wallet.linkedAt).toLocaleDateString(locale) })}
                      {wallet.connector ? ` · ${wallet.connector}` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <StatusPill tone="positive">{t('verified')}</StatusPill>
                  {!wallet.isPreferred ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => makePreferred(wallet.id)}
                      loading={busyId === wallet.id}
                    >
                      {t('makePreferred')}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => unlink(wallet.id)}
                    loading={busyId === wallet.id}
                  >
                    <Unlink className="size-3.5" />
                    {t('unlink')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {unlinked.length > 0 ? (
        <div className="space-y-3">
          <SectionHeader
            title={t('previouslyLinkedTitle')}
            description={t('previouslyLinkedBody')}
          />
          {unlinked.map((wallet) => (
            <Card key={wallet.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <AddressChip
                  address={wallet.address}
                  explorerUrl={`${EXPLORER}/address/${wallet.address}`}
                />
                <StatusPill tone="neutral">{t('unlinked')}</StatusPill>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <Notice tone="neutral" title={t('howLinkingWorksTitle')}>
        {t('howLinkingWorksBody')}
      </Notice>

      <WalletConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}
