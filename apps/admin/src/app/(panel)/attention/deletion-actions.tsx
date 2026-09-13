'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Notice } from '@flt/ui';

/** Complete (anonymise) or refuse (restore) an account deletion request. */
export function DeletionActions({ id }: { id: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'complete' | 'refuse'>('idle');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch('/api/account-deletions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(
          mode === 'complete' ? { action: 'complete', requestId: id } : { action: 'refuse', requestId: id, note },
        ),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Could not do that');
      setMode('idle');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not do that');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'idle') {
    return (
      <div className="flex gap-2">
        <Button variant="danger" size="sm" onClick={() => setMode('complete')}>
          Complete
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setMode('refuse')}>
          Refuse
        </Button>
      </div>
    );
  }

  return (
    <div className="min-w-[260px] space-y-2">
      {error ? <Notice tone="negative">{error}</Notice> : null}
      <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
        {mode === 'complete'
          ? 'Anonymises the email, name, date of birth, address and phone. Ledger, transactions and KYC documents are kept. This cannot be undone.'
          : 'Restores the account to the status it had before the request.'}
      </p>
      {mode === 'refuse' ? (
        <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why — recorded" />
      ) : null}
      <div className="flex gap-2">
        <Button
          variant="danger"
          size="sm"
          disabled={busy || (mode === 'refuse' && note.trim().length < 8)}
          loading={busy}
          onClick={() => void submit()}
        >
          Confirm
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMode('idle')}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
