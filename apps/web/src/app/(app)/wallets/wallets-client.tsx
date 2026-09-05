'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus, Star, Unlink, Wallet } from 'lucide-react';
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
      setError(caught instanceof ApiError ? caught.message : 'Could not update the wallet.');
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
      setError(caught instanceof ApiError ? caught.message : 'Could not unlink the wallet.');
    } finally {
      setBusyId(null);
    }
  }

  const linked = wallets.filter((wallet) => wallet.verified);
  const unlinked = wallets.filter((wallet) => !wallet.verified);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Wallets"
        description="Self-custody wallets linked to your account. Your keys never leave your device, and FLT cannot move your funds."
        action={
          <Button variant="primary" size="sm" onClick={() => setConnectOpen(true)}>
            <Plus className="size-3.5" />
            Connect a wallet
          </Button>
        }
      />

      {error ? <Notice tone="negative">{error}</Notice> : null}

      {linked.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Wallet className="size-4" />}
            title="No wallet linked"
            description="Link a self-custody wallet by signing a message. It costs no gas and does not authorise any spending."
            action={
              <Button variant="primary" size="sm" onClick={() => setConnectOpen(true)}>
                Connect a wallet
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
                          Preferred
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1.5 text-[11px] text-[var(--text-subtle)]">
                      Base · linked {new Date(wallet.linkedAt).toLocaleDateString()}
                      {wallet.connector ? ` · ${wallet.connector}` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <StatusPill tone="positive">Verified</StatusPill>
                  {!wallet.isPreferred ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => makePreferred(wallet.id)}
                      loading={busyId === wallet.id}
                    >
                      Make preferred
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => unlink(wallet.id)}
                    loading={busyId === wallet.id}
                  >
                    <Unlink className="size-3.5" />
                    Unlink
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
            title="Previously linked"
            description="These addresses are no longer linked. Their transaction history is retained — unlinking a wallet does not unmake the trades signed with it."
          />
          {unlinked.map((wallet) => (
            <Card key={wallet.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <AddressChip
                  address={wallet.address}
                  explorerUrl={`${EXPLORER}/address/${wallet.address}`}
                />
                <StatusPill tone="neutral">Unlinked</StatusPill>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <Notice tone="neutral" title="How linking works">
        Connecting a wallet lets your browser talk to it. Linking goes one step further: you sign a
        short message proving you control the address, which is what lets FLT show your balances and
        attribute your transactions. The signature is not a transaction, costs no gas, and grants no
        spending permission.
      </Notice>

      <WalletConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}
