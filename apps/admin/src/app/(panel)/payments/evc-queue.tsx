'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Notice } from '@flt/ui';

interface Row {
  id: string;
  email: string;
  tier: string;
  amountUsd: string;
  days: number;
  payerName: string;
  payerPhone: string;
  merchantNumber: string;
  status: string;
  reviewNote: string | null;
  createdAt: string;
}

/**
 * The review queue.
 *
 * Everything an operator needs to find the line on the merchant statement is
 * on the row itself — payer name, payer number, amount, the merchant number it
 * was quoted against, and when. Making them open a detail view to see the
 * phone number would mean reconciling a statement one click at a time.
 *
 * Both buttons require the note first. A confirmation without a reference is
 * indistinguishable from someone clicking through the queue, and this grants a
 * real paid plan.
 */
export function EvcQueue({ pending, recent }: { pending: Row[]; recent: Row[] }) {
  const router = useRouter();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: 'confirm' | 'reject') {
    const note = (notes[id] ?? '').trim();
    setError(null);
    setBusy(`${id}:${decision}`);

    try {
      const response = await fetch('/api/evc-payments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ paymentId: id, decision, note }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Could not record that');

      setNotes((current) => ({ ...current, [id]: '' }));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record that');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Awaiting review</CardTitle>
          <Badge tone={pending.length > 0 ? 'warning' : 'neutral'}>{pending.length}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <Notice tone="negative">{error}</Notice> : null}

          {pending.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-[var(--text-muted)]">
              Nothing waiting.
            </p>
          ) : (
            pending.map((row) => {
              const note = (notes[row.id] ?? '').trim();
              return (
                <div
                  key={row.id}
                  className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-[var(--text)]">
                        {row.payerName}{' '}
                        <span className="num text-[var(--text-muted)]">{row.payerPhone}</span>
                      </p>
                      <p className="truncate text-[11px] text-[var(--text-subtle)]">
                        {row.email} · dialled {row.merchantNumber} ·{' '}
                        {new Date(row.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone="accent">{row.tier}</Badge>
                      <span className="num text-[14px] font-semibold text-[var(--text)]">
                        ${row.amountUsd}
                      </span>
                    </div>
                  </div>

                  <Input
                    value={notes[row.id] ?? ''}
                    onChange={(event) =>
                      setNotes((current) => ({ ...current, [row.id]: event.target.value }))
                    }
                    placeholder="Statement reference, or why this is being rejected"
                  />

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busy === `${row.id}:confirm`}
                      disabled={note.length < 8 || busy !== null}
                      onClick={() => void decide(row.id, 'confirm')}
                    >
                      Confirm — grant {row.tier} for {row.days} days
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={busy === `${row.id}:reject`}
                      disabled={note.length < 8 || busy !== null}
                      onClick={() => void decide(row.id, 'reject')}
                    >
                      Not found
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recently confirmed</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-[var(--text-muted)]">None yet.</p>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {recent.map((row) => (
                <div key={row.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="text-[13px] text-[var(--text)]">
                      {row.payerName} — {row.email}
                    </p>
                    <p className="truncate text-[11px] text-[var(--text-subtle)]">
                      {row.reviewNote}
                    </p>
                  </div>
                  <span className="num shrink-0 text-[13px] text-[var(--text-muted)]">
                    {row.tier} · ${row.amountUsd}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
