'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { adminPost } from './actions';

/**
 * Resolve one manual approval — the gate that large or first-time-destination
 * withdrawals wait behind.
 *
 * The server refuses an approval whose subject is the acting administrator's own
 * account, so an operator cannot release their own held withdrawal.
 */
export function ApprovalDecision({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      await adminPost(`/api/admin/approvals/${approvalId}/decision`, { approve, note });
      setNote('');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error ? <p className="error">{error}</p> : null}
      <div className="inline">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note"
          aria-label="Decision note"
          style={{ minWidth: 180 }}
        />
        <button className="primary" disabled={busy} onClick={() => decide(true)}>
          Approve
        </button>
        <button
          className="danger"
          disabled={busy || note.trim().length === 0}
          onClick={() => decide(false)}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
