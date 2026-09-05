'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { adminPost } from './actions';

/**
 * Suspend or reactivate a customer account.
 *
 * Suspension stops new activity. It does not touch the customer's balance or
 * their ledger history, and it is not a deletion.
 */
export function UserStatusControl({ userId, status }: { userId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(next: 'ACTIVE' | 'SUSPENDED') {
    setBusy(true);
    setError(null);
    try {
      await adminPost(`/api/admin/users/${userId}/status`, { status: next });
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
      {status === 'ACTIVE' ? (
        <button className="danger" disabled={busy} onClick={() => set('SUSPENDED')}>
          Suspend account
        </button>
      ) : (
        <button disabled={busy} onClick={() => set('ACTIVE')}>
          Reactivate account
        </button>
      )}
    </div>
  );
}
