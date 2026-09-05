'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { adminPost } from './actions';

/**
 * Approve or reject one KYC profile.
 *
 * Rejection requires a reason — the server enforces this too, so the control is
 * a convenience rather than the guarantee.
 */
export function KycDecision({ userId }: { userId: string }) {
  const router = useRouter();
  const [tier, setTier] = useState('1');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(status: 'APPROVED' | 'REJECTED') {
    setBusy(true);
    setError(null);
    try {
      await adminPost(`/api/admin/kyc/${userId}/decision`, {
        status,
        tier: status === 'APPROVED' ? Number(tier) : undefined,
        reason: status === 'REJECTED' ? reason : undefined,
      });
      setReason('');
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
        <select value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Tier">
          <option value="1">Tier 1</option>
          <option value="2">Tier 2</option>
          <option value="3">Tier 3</option>
        </select>
        <button className="primary" disabled={busy} onClick={() => decide('APPROVED')}>
          Approve
        </button>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for rejection"
          aria-label="Reason for rejection"
          style={{ minWidth: 200 }}
        />
        <button
          className="danger"
          disabled={busy || reason.trim().length === 0}
          onClick={() => decide('REJECTED')}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
