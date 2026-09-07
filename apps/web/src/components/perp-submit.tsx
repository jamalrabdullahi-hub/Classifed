'use client';

import { useEffect, useState } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { KeyRound, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button, Notice } from '@flt/ui';
import { ApiError, post } from '@/lib/api';
import {
  authorizeAgent,
  forgetAgentKey,
  hasAgentKey,
  submitOrder,
  type SubmittableOrder,
} from '@/lib/hyperliquid-agent';

/**
 * Authorise, then submit.
 *
 * Two states, because the venue genuinely requires two different signatures and
 * conflating them would be dishonest about what the user is agreeing to:
 *
 *   1. **Authorisation** — one signature from their own wallet, granting a
 *      browser-held key permission to place orders and approving the maximum
 *      builder fee. Done once per browser session.
 *   2. **Submission** — signed locally by that key, with no wallet prompt.
 *
 * FLT sees neither signature and never holds the key. The order this submits
 * was specified entirely by the server; nothing here decides anything about the
 * trade. What happens afterwards is reported back so the order record can be
 * reconciled against the venue's own account of it.
 */

interface Props {
  orderId: string;
  order: SubmittableOrder;
  /** A bracket's legs, sent in the same request so the entry is never naked. */
  attached?: SubmittableOrder[];
  grouping?: 'na' | 'normalTpsl' | 'positionTpsl';
  venueName: string;
  /** The rate the user is asked to approve, as a percentage string. */
  builderMaxFeeRate: string;
  onDone?: () => void;
}

type Phase = 'checking' | 'needs-auth' | 'authorising' | 'ready' | 'submitting' | 'done';

export function PerpSubmit({
  orderId,
  order,
  attached,
  grouping,
  venueName,
  builderMaxFeeRate,
  onDone,
}: Props) {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    setPhase(hasAgentKey(address) ? 'ready' : 'needs-auth');
  }, [address]);

  async function authorise() {
    if (!walletClient || !address) return;

    setError(null);
    setPhase('authorising');

    try {
      await authorizeAgent({
        wallet: walletClient,
        owner: address,
        builderAddress: (order.builderAddress as `0x${string}` | null) ?? null,
        builderMaxFeeRate,
      });
      setPhase('ready');
    } catch (caught) {
      setPhase('needs-auth');
      setError(readError(caught));
    }
  }

  async function send() {
    if (!address) return;

    setError(null);
    setPhase('submitting');

    try {
      const outcome = await submitOrder({ owner: address, order, attached, grouping });

      // Reported to FLT as a claim, not as proof. The worker reconciles it
      // against the venue's own record and is what actually marks it filled.
      try {
        await post(`/api/perps/orders/${orderId}`, { venueOrderId: outcome.venueOrderId });
      } catch {
        // The order is at the venue either way; failing to record that here is
        // a bookkeeping problem, not a trading one, and must not be shown as a
        // failed trade.
      }

      setResult(outcome.status);
      setPhase('done');
      onDone?.();
    } catch (caught) {
      setPhase('ready');
      setError(readError(caught));
    }
  }

  if (!isConnected || !address) {
    return (
      <Notice tone="warning" title="Connect your wallet">
        Your wallet has to be connected to authorise and place orders.
      </Notice>
    );
  }

  if (phase === 'done') {
    return (
      <div className="space-y-2">
        <Notice tone="positive" title="Order sent">
          {venueName} reported: {result}. It will appear in your positions once the venue confirms
          it.
        </Notice>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? <Notice tone="negative">{error}</Notice> : null}

      {phase === 'needs-auth' || phase === 'authorising' ? (
        <>
          <Notice
            tone="warning"
            icon={<KeyRound className="size-4" />}
            title="Authorise this browser once"
          >
            {venueName} will not accept orders signed by your wallet directly. Signing below creates
            a key held only by this browser tab that can place and cancel orders on your behalf. It
            <strong className="text-[var(--text)]"> cannot withdraw or move your funds</strong>, and
            it is discarded when you close the tab.
            {order.builderAddress ? (
              <span className="mt-2 block">
                You will also approve FLT&apos;s fee, up to a maximum of {builderMaxFeeRate}.
              </span>
            ) : null}
          </Notice>

          <Button
            variant="primary"
            block
            loading={phase === 'authorising'}
            disabled={!walletClient}
            onClick={() => void authorise()}
          >
            Authorise with my wallet
          </Button>
        </>
      ) : (
        <>
          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-[var(--text-subtle)]">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--positive)]" />
            This browser is authorised. The order is signed locally and sent straight to{' '}
            {venueName} — it does not pass through FLT.
          </p>

          <Button
            variant="primary"
            block
            loading={phase === 'submitting'}
            onClick={() => void send()}
          >
            Place order
          </Button>

          <button
            type="button"
            onClick={() => {
              forgetAgentKey(address);
              setPhase('needs-auth');
            }}
            className="flex w-full items-center justify-center gap-1.5 text-[11px] text-[var(--text-subtle)] hover:text-[var(--text-muted)]"
          >
            <TriangleAlert className="size-3" />
            Forget this browser&apos;s trading key
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The venue's errors are the useful ones and arrive as plain messages.
 * Surfaced rather than replaced, because "order failed" tells nobody whether
 * they are out of margin or the market moved.
 */
function readError(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error) {
    // A rejected wallet prompt is a decision, not a fault.
    if (/user rejected|denied|rejected the request/i.test(caught.message)) {
      return 'You declined the signature, so nothing was sent.';
    }
    return caught.message;
  }
  return 'Something went wrong and the order was not sent.';
}
