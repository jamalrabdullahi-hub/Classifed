'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The market-making kill switch and caps, as an operator sees them.
 *
 * Deliberately a small set of switches, not a trading screen: enable/disable,
 * halt/resume (the kill switch), and the caps the book runs under. It never sets
 * a quote — the runner owns those, and an operator steering a live ladder by
 * hand is the manual trading this is not.
 */

export interface MarketMakerControlsProps {
  hasConfig: boolean;
  isEnabled: boolean;
  halted: boolean;
  halfSpreadBps: number;
  levels: number;
  levelSize: string;
  levelStepBps: number;
  maxInventory: string;
  maxDailyLossUsd: string;
  requoteMs: number;
}

export function MarketMakerControls(props: MarketMakerControlsProps) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [caps, setCaps] = useState({
    halfSpreadBps: String(props.halfSpreadBps),
    levels: String(props.levels),
    levelSize: props.levelSize,
    levelStepBps: String(props.levelStepBps),
    maxInventory: props.maxInventory,
    maxDailyLossUsd: props.maxDailyLossUsd,
    requoteMs: String(props.requoteMs),
  });

  async function send(payload: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/market-maker', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, reason }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? 'The request failed');
        return;
      }
      router.refresh();
    } catch {
      setError('The request failed');
    } finally {
      setBusy(false);
    }
  }

  function requireReason(): boolean {
    if (reason.trim().length < 8) {
      setError('Give a reason of at least 8 characters — it is recorded in the audit trail.');
      return false;
    }
    return true;
  }

  function onUpdate(event: FormEvent): void {
    event.preventDefault();
    if (!requireReason()) return;
    void send({
      action: 'update',
      halfSpreadBps: Number(caps.halfSpreadBps),
      levels: Number(caps.levels),
      levelSize: caps.levelSize,
      levelStepBps: Number(caps.levelStepBps),
      maxInventory: caps.maxInventory,
      maxDailyLossUsd: caps.maxDailyLossUsd,
      requoteMs: Number(caps.requoteMs),
    });
  }

  const field = 'rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100';

  return (
    <div className="space-y-4 rounded border border-neutral-800 p-4">
      <label className="block text-sm text-neutral-300">
        Reason (recorded)
        <input
          className={`mt-1 w-full ${field}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why you are changing the book"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !props.hasConfig}
          className="rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-100 disabled:opacity-40"
          onClick={() => requireReason() && void send({ action: 'enable' })}
        >
          Enable
        </button>
        <button
          type="button"
          disabled={busy}
          className="rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-100 disabled:opacity-40"
          onClick={() => requireReason() && void send({ action: 'disable' })}
        >
          Disable
        </button>
        <button
          type="button"
          disabled={busy}
          className="rounded bg-amber-700 px-3 py-1 text-sm text-white disabled:opacity-40"
          onClick={() => requireReason() && void send({ action: 'halt' })}
        >
          Halt (kill switch)
        </button>
        <button
          type="button"
          disabled={busy}
          className="rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-100 disabled:opacity-40"
          onClick={() => requireReason() && void send({ action: 'resume' })}
        >
          Resume
        </button>
      </div>

      <form onSubmit={onUpdate} className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="text-xs text-neutral-400">
            Half-spread (bps)
            <input className={`mt-1 w-full ${field}`} value={caps.halfSpreadBps}
              onChange={(e) => setCaps({ ...caps, halfSpreadBps: e.target.value })} />
          </label>
          <label className="text-xs text-neutral-400">
            Levels
            <input className={`mt-1 w-full ${field}`} value={caps.levels}
              onChange={(e) => setCaps({ ...caps, levels: e.target.value })} />
          </label>
          <label className="text-xs text-neutral-400">
            Level size
            <input className={`mt-1 w-full ${field}`} value={caps.levelSize}
              onChange={(e) => setCaps({ ...caps, levelSize: e.target.value })} />
          </label>
          <label className="text-xs text-neutral-400">
            Level step (bps)
            <input className={`mt-1 w-full ${field}`} value={caps.levelStepBps}
              onChange={(e) => setCaps({ ...caps, levelStepBps: e.target.value })} />
          </label>
          <label className="text-xs text-neutral-400">
            Max inventory
            <input className={`mt-1 w-full ${field}`} value={caps.maxInventory}
              onChange={(e) => setCaps({ ...caps, maxInventory: e.target.value })} />
          </label>
          <label className="text-xs text-neutral-400">
            Max daily loss (USD)
            <input className={`mt-1 w-full ${field}`} value={caps.maxDailyLossUsd}
              onChange={(e) => setCaps({ ...caps, maxDailyLossUsd: e.target.value })} />
          </label>
          <label className="text-xs text-neutral-400">
            Requote (ms)
            <input className={`mt-1 w-full ${field}`} value={caps.requoteMs}
              onChange={(e) => setCaps({ ...caps, requoteMs: e.target.value })} />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-neutral-800 px-3 py-1 text-sm text-neutral-100 disabled:opacity-40"
          >
            {props.hasConfig ? 'Save caps' : 'Create book'}
          </button>
          {props.halted ? (
            <span className="text-xs text-amber-400">Halted — resume to quote again.</span>
          ) : null}
        </div>
      </form>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}
    </div>
  );
}
