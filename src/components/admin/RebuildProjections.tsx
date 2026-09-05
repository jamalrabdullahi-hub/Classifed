'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { adminPost } from './actions';

/**
 * Rebuild the balance projections from the ledger entries.
 *
 * Safe at any time, and the reason it is safe is worth stating: the entries are
 * immutable and are the source of truth, so this recomputes a cache rather than
 * editing a balance. It repairs drift; it cannot create or destroy value.
 */
export function RebuildProjections() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      await adminPost('/api/admin/reconciliation/rebuild', {});
      setResult('Projections rebuilt from the ledger entries.');
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
      {result ? <p className="ok">{result}</p> : null}
      <button disabled={busy} onClick={run}>
        {busy ? 'Rebuilding…' : 'Rebuild projections from entries'}
      </button>
    </div>
  );
}
