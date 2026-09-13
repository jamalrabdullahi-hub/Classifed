'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Notice } from '@flt/ui';

/**
 * The two actions an operator legitimately has on stuck money.
 *
 * Both are destructive in the sense that matters — one releases a reservation,
 * the other re-arms a transfer — so both demand a written reason, and neither
 * is a single unguarded click. A withdrawal in particular is confirmed twice,
 * because releasing one whose transfer *did* leave means the participant keeps
 * a balance they have already been paid.
 */
export function AttentionActions({ kind, id }: { kind: 'withdrawal' | 'deposit'; id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch('/api/attention', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ kind, id, reason: reason.trim() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Could not do that');
      setOpen(false);
      setReason('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not do that');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {kind === 'withdrawal' ? 'Release' : 'Requeue'}
      </Button>
    );
  }

  return (
    <div className="min-w-[260px] space-y-2">
      {error ? <Notice tone="negative">{error}</Notice> : null}

      <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
        {kind === 'withdrawal'
          ? 'Only after checking the omnibus and finding no transfer for this amount to this address. Releasing one that did leave pays the participant twice.'
          : 'The sweep will be attempted again. Make sure the omnibus has gas first, or this spends the retry budget for nothing.'}
      </p>

      <Input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why — recorded against your account"
      />

      <div className="flex gap-2">
        <Button
          variant="danger"
          size="sm"
          disabled={reason.trim().length < 8 || busy}
          loading={busy}
          onClick={() => void submit()}
        >
          Confirm
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
