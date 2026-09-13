'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Notice } from '@flt/ui';

export interface FiatWithdrawalRow {
  id: string;
  email: string;
  method: string;
  reference: string;
  amountUsd: string;
  feeUsd: string;
  netUsd: string;
  payeeName: string;
  payeePhone: string | null;
  payeeEmail: string | null;
  bankName: string | null;
  accountNumber: string | null;
  routingNumber: string | null;
  swift: string | null;
  country: string | null;
  createdAt: string;
}

function age(createdAt: string): { label: string; tone: string } {
  const hours = (Date.now() - Date.parse(createdAt)) / 3_600_000;
  const label =
    hours < 1
      ? `${Math.max(1, Math.round(hours * 60))}m`
      : hours < 24
        ? `${Math.floor(hours)}h`
        : `${Math.floor(hours / 24)}d ${Math.floor(hours % 24)}h`;
  const tone =
    hours >= 12 ? 'text-[var(--negative)]' : hours >= 6 ? 'text-[var(--warning)]' : 'text-[var(--text-subtle)]';
  return { label, tone };
}

/**
 * Cash withdrawals waiting to be paid.
 *
 * The operator pays the **net** amount — the fee is kept — to the destination
 * shown, then records the payout reference. The destination is read-only for
 * the same reason as on the deposit queue: an operator retyping an account
 * number is the most expensive mistake available here.
 */
export function FiatWithdrawalQueue({ rows }: { rows: FiatWithdrawalRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function act(body: Record<string, unknown>) {
    setError(null);
    setBusy(`${String(body.withdrawalId)}:${String(body.action)}`);
    try {
      const response = await fetch('/api/fiat-withdrawals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Could not record that');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record that');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cash withdrawals to pay</CardTitle>
        <Badge tone={rows.length > 0 ? 'warning' : 'neutral'}>{rows.length}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <Notice tone="negative">{error}</Notice> : null}

        {rows.length === 0 ? (
          <p className="py-4 text-center text-[13px] text-[var(--text-muted)]">Nothing to pay.</p>
        ) : (
          rows.map((row) => {
            const waiting = age(row.createdAt);
            const ref = (refs[row.id] ?? '').trim();
            const note = (notes[row.id] ?? '').trim();
            return (
              <div key={row.id} className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--text)]">
                      {row.email} <span className="text-[var(--text-subtle)]">· {row.method}</span>
                    </p>
                    <p className="num text-[11px] text-[var(--text-subtle)]">
                      {row.reference} · waiting <span className={waiting.tone}>{waiting.label}</span>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="num text-[15px] font-semibold text-[var(--text)]">Pay ${row.netUsd}</p>
                    <p className="num text-[11px] text-[var(--text-subtle)]">
                      of ${row.amountUsd} · fee ${row.feeUsd}
                    </p>
                  </div>
                </div>

                <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-sunken)] p-2 text-[12px] leading-relaxed">
                  <p className="text-[10px] uppercase tracking-[0.06em] text-[var(--text-subtle)]">Pay to</p>
                  <p className="select-all text-[var(--text)]">{row.payeeName}</p>
                  {row.payeePhone ? <p className="num select-all text-[var(--text)]">EVC {row.payeePhone}</p> : null}
                  {row.payeeEmail ? <p className="select-all text-[var(--text)]">PayPal {row.payeeEmail}</p> : null}
                  {row.bankName ? (
                    <>
                      <p className="select-all text-[var(--text)]">{row.bankName}</p>
                      <p className="num select-all text-[var(--text)]">Account {row.accountNumber}</p>
                      {row.routingNumber ? <p className="num select-all text-[var(--text)]">Routing {row.routingNumber}</p> : null}
                      {row.swift ? <p className="num select-all text-[var(--text)]">SWIFT {row.swift}</p> : null}
                      {row.country ? <p className="text-[var(--text)]">{row.country}</p> : null}
                    </>
                  ) : null}
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    value={refs[row.id] ?? ''}
                    onChange={(event) => setRefs((current) => ({ ...current, [row.id]: event.target.value }))}
                    placeholder="Payout reference (bank, EVC or PayPal)"
                  />
                  <Input
                    value={notes[row.id] ?? ''}
                    onChange={(event) => setNotes((current) => ({ ...current, [row.id]: event.target.value }))}
                    placeholder="Reason, if rejecting"
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={ref.length < 3 || busy !== null}
                    loading={busy === `${row.id}:paid`}
                    onClick={() => void act({ action: 'paid', withdrawalId: row.id, payoutReference: ref })}
                  >
                    Confirm paid ${row.netUsd}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={note.length < 8 || busy !== null}
                    loading={busy === `${row.id}:reject`}
                    onClick={() => void act({ action: 'reject', withdrawalId: row.id, note })}
                  >
                    Reject and release
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
