'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useSignMessage, useSwitchChain } from 'wagmi';
import { AlertTriangle, Check, ShieldCheck, Wallet } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Notice,
  cn,
} from '@flt/ui';
import { ApiError, post } from '@/lib/api';
import { SUPPORTED_CHAIN } from '@/lib/wagmi';

interface Challenge {
  nonce: string;
  message: string;
  expiresAt: string;
}

type Step = 'choose' | 'connecting' | 'wrong-chain' | 'sign' | 'done';

/**
 * Wallet connection and linking.
 *
 * Two distinct actions the interface keeps distinct, because conflating them is
 * how users end up not understanding what they agreed to:
 *
 *   1. **Connect** — the browser talks to the wallet. Nothing reaches FLT.
 *   2. **Link** — the user signs a message proving they control the address, and
 *      only then does FLT associate it with their account.
 *
 * The signing step says plainly what the signature does and does not authorise.
 * A user who has been taught that unexplained signature requests are normal is
 * a user who will eventually sign something harmful.
 */
export function WalletConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { address, isConnected, chainId, connector } = useAccount();
  const { connectors, connectAsync, isPending: connecting } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();

  const [step, setStep] = useState<Step>('choose');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep the step in step with the wallet's own state: a user who switches
  // network or disconnects in their wallet should see the dialog follow.
  useEffect(() => {
    if (!open) return;
    if (!isConnected) {
      setStep('choose');
    } else if (chainId !== SUPPORTED_CHAIN.id) {
      setStep('wrong-chain');
    } else if (step === 'choose' || step === 'connecting' || step === 'wrong-chain') {
      setStep('sign');
    }
  }, [open, isConnected, chainId, step]);

  const reset = useCallback(() => {
    setError(null);
    setBusy(false);
  }, []);

  async function onConnect(connectorId: string) {
    reset();
    const target = connectors.find((entry) => entry.uid === connectorId);
    if (!target) return;

    setStep('connecting');
    try {
      await connectAsync({ connector: target, chainId: SUPPORTED_CHAIN.id });
    } catch (caught) {
      setStep('choose');
      setError(describeWalletError(caught));
    }
  }

  async function onSwitchChain() {
    reset();
    setBusy(true);
    try {
      await switchChainAsync({ chainId: SUPPORTED_CHAIN.id });
    } catch (caught) {
      setError(describeWalletError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onSign() {
    if (!address) return;
    reset();
    setBusy(true);

    try {
      // The server issues the message. Signing anything the client composed
      // would defeat the point of the nonce.
      const challenge = await post<Challenge>('/api/wallets/challenge', {
        address,
        chainId: SUPPORTED_CHAIN.id,
      });

      const signature = await signMessageAsync({ message: challenge.message });

      await post('/api/wallets/link', {
        nonce: challenge.nonce,
        message: challenge.message,
        signature,
        connector: connector?.name ?? 'unknown',
      });

      setStep('done');
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError(describeWalletError(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    await disconnectAsync().catch(() => undefined);
    setStep('choose');
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {step === 'done' ? 'Wallet linked' : 'Connect a wallet'}
          </DialogTitle>
          <DialogDescription>
            {step === 'done'
              ? 'This address is now linked to your FLT account.'
              : 'FLT never holds your assets and never asks for a seed phrase or private key.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {error ? (
            <Notice tone="negative" icon={<AlertTriangle className="size-4" />}>
              {error}
            </Notice>
          ) : null}

          {step === 'choose' || step === 'connecting' ? (
            <div className="space-y-2">
              {connectors.length === 0 ? (
                <Notice tone="warning">
                  No wallet was detected in this browser. Install MetaMask or another
                  self-custody wallet extension to continue.
                </Notice>
              ) : (
                connectors.map((entry) => (
                  <button
                    key={entry.uid}
                    type="button"
                    onClick={() => onConnect(entry.uid)}
                    disabled={connecting}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-[var(--radius-md)] border px-3.5 py-3',
                      'border-[var(--border)] bg-[var(--surface-sunken)] text-left transition-colors',
                      'hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]',
                      'disabled:pointer-events-none disabled:opacity-50',
                    )}
                  >
                    <span className="flex size-8 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)]">
                      <Wallet className="size-4 text-[var(--text-muted)]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-[var(--text)]">
                        {entry.name}
                      </span>
                      <span className="block text-[11px] text-[var(--text-subtle)]">
                        {entry.type === 'injected' ? 'Browser extension' : 'Scan with your wallet'}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}

          {step === 'wrong-chain' ? (
            <>
              <Notice tone="warning" title={`Switch to ${SUPPORTED_CHAIN.name}`}>
                Your wallet is on a different network. FLT trades on {SUPPORTED_CHAIN.name} in this
                release.
              </Notice>
              <Button variant="primary" block onClick={onSwitchChain} loading={busy}>
                Switch to {SUPPORTED_CHAIN.name}
              </Button>
            </>
          ) : null}

          {step === 'sign' ? (
            <>
              <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3.5">
                <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--text-subtle)]">
                  Address
                </p>
                <p className="num mt-1 break-all font-mono text-[12px] text-[var(--text)]">
                  {address}
                </p>
              </div>

              {/* Spelled out deliberately. This is the habit that protects
                  people from the next signature request they see. */}
              <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--accent-border)] bg-[var(--accent-subtle)] p-3.5">
                <p className="flex items-center gap-2 text-[13px] font-medium text-[var(--accent-text)]">
                  <ShieldCheck className="size-4" />
                  What this signature does
                </p>
                <ul className="space-y-1 text-[12px] leading-relaxed text-[var(--accent-text)] opacity-90">
                  <li>Proves you control this address.</li>
                  <li>Costs no gas and is not a transaction.</li>
                  <li>Does not let FLT move, spend or access your funds.</li>
                </ul>
              </div>

              <Button variant="primary" block onClick={onSign} loading={busy}>
                Sign to link this wallet
              </Button>
              <Button variant="ghost" block onClick={onCancel} disabled={busy}>
                Cancel and disconnect
              </Button>
            </>
          ) : null}

          {step === 'done' ? (
            <>
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <span className="flex size-11 items-center justify-center rounded-full border border-[var(--positive-border)] bg-[var(--positive-subtle)]">
                  <Check className="size-5 text-[var(--positive)]" />
                </span>
                <p className="num break-all font-mono text-[12px] text-[var(--text-muted)]">
                  {address}
                </p>
              </div>
              <Button variant="primary" block onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Turns a wallet's error into something a person can act on.
 *
 * A user who declines a prompt has not hit an error, and telling them
 * "something went wrong" for a deliberate choice is both wrong and alarming.
 */
function describeWalletError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/user rejected|user denied|rejected the request/i.test(message)) {
    return 'You declined the request in your wallet. Nothing was signed.';
  }
  if (/already pending|request of type/i.test(message)) {
    return 'Your wallet already has a pending request. Open it and respond there first.';
  }
  if (/chain|network/i.test(message) && /unsupported|mismatch/i.test(message)) {
    return `Switch your wallet to ${SUPPORTED_CHAIN.name} and try again.`;
  }
  if (/connector not found|no provider/i.test(message)) {
    return 'That wallet is no longer available in this browser.';
  }
  return 'Your wallet could not complete the request. Try again.';
}
