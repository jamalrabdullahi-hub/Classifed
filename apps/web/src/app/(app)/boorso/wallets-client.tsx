'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
import { ApiError, apiFetch, del } from '@/lib/api';

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
