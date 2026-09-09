'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Notice } from '@flt/ui';

interface Row {
  id: string;
  email: string;
  originatorName: string;
  originatorWallet: string;
  beneficiaryName: string;
  beneficiaryPhone: string;
  beneficiaryRelationship: string;
  purpose: string;
  sendAmountUsd: string;
  payoutAmount: string;
  payoutCurrency: string;
  txHash: string | null;
  heldReason: string | null;
  payoutReference: string | null;
  createdAt: string;
}

/**
 * The payout queue.
 *
 * Every row here is money FLT is already holding — the inbound transfer has
 * been verified on-chain — so the liability total sits at the top rather than
 * being something an operator has to add up. If the EVC float cannot cover
 * that number, the answer is to stop taking transfers, and that has to be
 * visible before the first payout is sent, not after the last one bounces.
 *
 * Both parties are shown in full on the row. This is a Travel Rule record and
 * a screening decision at the same time, and neither can be made from a name
 * and an amount alone — the relationship and the stated purpose are the
 * sender's own account of a payment to somebody FLT has never checked.
 */
export function RemittanceQueue({
  pending,
  recent,
  liability,
}: {
  pending: Row[];
  recent: Row[];
  liability: { count: number; usd: string; payout: string; currency: string };
}) {
  const router = useRouter();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, action: 'paid' | 'hold' | 'reject') {
    const note = (notes[id] ?? '').trim();
    setError(null);
    setBusy(`${id}:${action}`);

    try {
      const response = await fetch('/api/remittance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(
          action === 'paid'
            ? { action, orderId: id, reference: note }
            : { action, orderId: id, reason: note },
        ),
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
          <CardTitle>Owed right now</CardTitle>
          <Badge tone={liability.count > 0 ? 'warning' : 'neutral'}>
            {liability.count} waiting
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-6">
            <div>
              <p className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-subtle)]">
                Received in stablecoin
              </p>
              <p className="num text-[20px] font-semibold text-[var(--text)]">${liability.usd}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-subtle)]">
                To pay out
              </p>
              <p className="num text-[20px] font-semibold text-[var(--text)]">
                {liability.payout} {liability.currency}
              </p>
            </div>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-[var(--text-subtle)]">
            This is money already taken from participants and not yet delivered. If your EVC float
            cannot cover it, turn the corridor off before sending any of it.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Awaiting payout</CardTitle>
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
                  {row.heldReason ? (
                    <Notice tone="warning" title="Held">
                      {row.heldReason}
                    </Notice>
                  ) : null}

                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="text-[13px] text-[var(--text)]">
                        <span className="text-[var(--text-subtle)]">From</span>{' '}
                        {row.originatorName}
                      </p>
                      <p className="num truncate text-[11px] text-[var(--text-subtle)]">
                        {row.email} · {row.originatorWallet}
                      </p>
                      <p className="text-[13px] text-[var(--text)]">
                        <span className="text-[var(--text-subtle)]">To</span>{' '}
                        {row.beneficiaryName}{' '}
                        <span className="num text-[var(--text-muted)]">{row.beneficiaryPhone}</span>
                      </p>
                      <p className="text-[11px] text-[var(--text-subtle)]">
                        {row.beneficiaryRelationship} · {row.purpose} ·{' '}
                        {new Date(row.createdAt).toLocaleString()}
                      </p>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="num text-[15px] font-semibold text-[var(--text)]">
                        {row.payoutAmount} {row.payoutCurrency}
                      </p>
                      <p className="num text-[11px] text-[var(--text-subtle)]">
                        from ${row.sendAmountUsd}
                      </p>
                    </div>
                  </div>

                  <Input
                    value={notes[row.id] ?? ''}
                    onChange={(event) =>
                      setNotes((current) => ({ ...current, [row.id]: event.target.value }))
                    }
                    placeholder="EVC reference once paid, or the reason for a hold or refusal"
                  />

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busy === `${row.id}:paid`}
                      disabled={note.length < 8 || busy !== null}
                      onClick={() => void act(row.id, 'paid')}
                    >
                      Paid — {row.payoutAmount} {row.payoutCurrency} sent
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === `${row.id}:hold`}
                      disabled={note.length < 8 || busy !== null}
                      onClick={() => void act(row.id, 'hold')}
                    >
                      Hold
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={busy === `${row.id}:reject`}
                      disabled={note.length < 8 || busy !== null}
                      onClick={() => void act(row.id, 'reject')}
                    >
                      Refuse
                    </Button>
                  </div>

                  {/* Said plainly, next to the button that does it: refusing
                      does not give the crypto back. */}
                  <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">
                    Refusing does not return the stablecoin — it is already in the receiving
                    wallet. A refusal leaves a debt to settle with the sender directly.
                  </p>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recently paid</CardTitle>
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
                      {row.originatorName} → {row.beneficiaryName}
                    </p>
                    <p className="num truncate text-[11px] text-[var(--text-subtle)]">
                      {row.payoutReference}
                    </p>
                  </div>
                  <span className="num shrink-0 text-[13px] text-[var(--text-muted)]">
                    {row.payoutAmount} {row.payoutCurrency}
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
