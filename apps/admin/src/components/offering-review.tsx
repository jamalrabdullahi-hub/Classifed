'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@flt/ui';

/**
 * The published-offering review queue.
 *
 * A participant's offering trades real money for whoever activates it, so it
 * does not go PUBLIC on its own say-so — an operator approves it first. Approve
 * publishes it (and starts the 50% creator share); reject sends it back.
 */
export interface PendingOffering {
  slug: string;
  name: string;
  creatorEmail: string | null;
  strategyType: string;
  symbols: string[];
}

export function OfferingReview({ pending }: { pending: PendingOffering[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function review(slug: string, approve: boolean) {
    setError(null);
    setBusy(slug);
    try {
      const response = await fetch('/api/algorithms/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug,
          approve,
          reason: `${approve ? 'Approved' : 'Rejected'} published offering ${slug}`,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(payload.error?.message ?? 'Could not review');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not review');
    } finally {
      setBusy(null);
    }
  }

  if (pending.length === 0) return null;

  return (
    <div className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--warning)] p-4">
      <h2 className="text-[14px] font-semibold text-[var(--text)]">Published offerings awaiting review</h2>
      {error ? <Notice tone="negative">{error}</Notice> : null}
      {pending.map((offering) => (
        <div key={offering.slug} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border)] p-3 text-[12px]">
          <div>
            <p className="font-medium text-[var(--text)]">{offering.name}</p>
            <p className="text-[10.5px] text-[var(--text-subtle)]">
              {offering.slug} · {offering.strategyType} · {offering.symbols.join(', ')} ·{' '}
              {offering.creatorEmail ?? 'unknown creator'}
            </p>
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="primary" loading={busy === offering.slug} onClick={() => void review(offering.slug, true)}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" loading={busy === offering.slug} onClick={() => void review(offering.slug, false)}>
              Reject
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
