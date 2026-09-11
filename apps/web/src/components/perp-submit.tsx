'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button, Notice } from '@flt/ui';
import { ApiError, post } from '@/lib/api';

/**
 * Placing a perpetual order under custody.
 *
 * The order is placed **server-side**, from FLT's omnibus venue account, signed
 * by the agent key FLT holds (ADR 0005). The participant connects no wallet and
 * signs nothing; their margin is reserved on the ledger before the order is
 * broadcast (ADR 0006 P3).
 *
 * This replaces the browser-signed flow entirely: there is no per-browser agent
 * key, no wallet prompt, and no signature the server cannot reproduce.
 */

interface Props {
  symbol: string;
  side: 'LONG' | 'SHORT';
  /** Position size in USD — converted to contracts on the server, at its mark. */
  usdNotional: string;
  leverage: number;
  slippageBps?: number;
  venueName: string;
  /** The maximum fee FLT charges, quoted to the participant. */
  builderMaxFeeRate?: string;
  onDone?: () => void;
}

export function PerpSubmit({
  symbol,
  side,
  usdNotional,
  leverage,
  slippageBps = 50,
  venueName,
  builderMaxFeeRate,
  onDone,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function place() {
    setError(null);
    setBusy(true);
    try {
      await post('/api/perps/orders/execute', {
        symbol,
        side,
        usdNotional,
        leverage,
        slippageBps,
      });
      setDone(true);
      onDone?.();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Notice tone="positive" title="Order placed">
        Your position will appear once {venueName} confirms it. Your margin is reserved from your
        balance.
      </Notice>
    );
  }

  return (
    <div className="space-y-3">
      {error ? <Notice tone="negative">{error}</Notice> : null}

      <p className="flex items-start gap-2 text-[11px] leading-relaxed text-[var(--text-subtle)]">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--positive)]" />
        Placed from FLT&apos;s custody account and signed by FLT. You connect no wallet and sign
        nothing — your margin is reserved from your balance.
        {builderMaxFeeRate ? ` FLT's fee is capped at ${builderMaxFeeRate}.` : ''}
      </p>

      <Button variant="primary" block loading={busy} onClick={() => void place()}>
        Place order
      </Button>
    </div>
  );
}
