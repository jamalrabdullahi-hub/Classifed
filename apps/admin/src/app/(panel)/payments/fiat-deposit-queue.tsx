'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Notice } from '@flt/ui';

interface Row {
  id: string;
  email: string;
  method: string;
  currency: string;
  amountFiat: string;
  netUsd: string | null;
  reference: string;
  status: string;
  walletAddress: string | null;
  walletChainId: number | null;
  bankReference: string | null;
  createdAt: string;
}

/**
 * The two operator steps of a fiat deposit.
 *
 * Split into two queues rather than one list with a mode switch, because they
 * are different jobs done at different times: one is reconciling a bank
 * statement, the other is sending crypto. An operator working through the
 * second queue is holding money that is already owed, which is why the
 * outstanding figure sits above it.
 *
 * The delivery form pre-fills the participant's own wallet address and treats
 * it as read-only. An operator retyping an address is the single most
 * expensive mistake available on this screen, and the address is already known
 * — the wallet was provisioned by FLT and its id is on the row.
 */
export function FiatDepositQueue({
  awaiting,
  toDeliver,
  liability,
}: {
  awaiting: Row[];
  toDeliver: Row[];
  liability: { count: number; usd: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [received, setReceived] = useState<Record<string, string>>({});
  const [fee, setFee] = useState<Record<string, string>>({});
  const [bankRef, setBankRef] = useState<Record<string, string>>({});
  const [txHash, setTxHash] = useState<Record<string, string>>({});

  async function act(id: string, body: Record<string, unknown>) {
    setError(null);
    setBusy(`${id}:${String(body.action)}`);
    try {
      const response = await fetch('/api/fiat-deposits', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ depositId: id, ...body }),
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
    <div className="space-y-5">
      {error ? <Notice tone="negative">{error}</Notice> : null}

      <Card>
        <CardHeader>
          <CardTitle>Awaiting funds</CardTitle>
          <Badge tone={awaiting.length > 0 ? 'warning' : 'neutral'}>{awaiting.length}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {awaiting.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-[var(--text-muted)]">
              Nothing waiting.
            </p>
          ) : (
            awaiting.map((row) => {
              const amount = (received[row.id] ?? '').trim();
              const reference = (bankRef[row.id] ?? '').trim();
              const ready = amount.length > 0 && reference.length >= 3;

              return (
                <div
                  key={row.id}
                  className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="num text-[13px] font-medium text-[var(--text)]">
                        {row.reference}
                      </p>
                      <p className="truncate text-[11px] text-[var(--text-subtle)]">
                        {row.email} · {row.method} · {new Date(row.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <span className="num shrink-0 text-[14px] font-semibold text-[var(--text)]">
                      {row.amountFiat} {row.currency}
                    </span>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-3">
                    <Input
                      value={received[row.id] ?? ''}
                      onChange={(event) =>
                        setReceived((current) => ({ ...current, [row.id]: event.target.value }))
                      }
                      placeholder="Amount received"
                      className="num"
                    />
                    <Input
                      value={fee[row.id] ?? ''}
                      onChange={(event) =>
                        setFee((current) => ({ ...current, [row.id]: event.target.value }))
                      }
                      placeholder="Fee"
                      className="num"
                    />
                    <Input
                      value={bankRef[row.id] ?? ''}
                      onChange={(event) =>
                        setBankRef((current) => ({ ...current, [row.id]: event.target.value }))
                      }
                      placeholder="Statement line"
                    />
                  </div>

                  {/* Stated rather than assumed: the claimed figure and the
                      arrived figure differ often enough that crediting the
                      wrong one is a live risk, not a theoretical one. */}
                  <p className="text-[11px] text-[var(--text-subtle)]">
                    Enter what actually arrived, which may differ from the{' '}
                    {row.amountFiat} {row.currency} they said they would send.
                  </p>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!ready || busy !== null}
                      loading={busy === `${row.id}:receive`}
                      onClick={() =>
                        void act(row.id, {
                          action: 'receive',
                          amountReceived: amount,
                          feeUsd: (fee[row.id] ?? '0').trim() || '0',
                          bankReference: reference,
                        })
                      }
                    >
                      Confirm received
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={reference.length < 8 || busy !== null}
                      loading={busy === `${row.id}:reject`}
                      onClick={() => void act(row.id, { action: 'reject', note: reference })}
                    >
                      Reject
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
          <CardTitle>Owed — send the crypto</CardTitle>
          <Badge tone={liability.count > 0 ? 'negative' : 'neutral'}>
            {liability.count} · ${liability.usd}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* The figure that matters most on this page: money taken and not
              yet delivered is the whole exposure this feature carries. */}
          {liability.count > 0 ? (
            <Notice tone="warning" title="Outstanding to participants">
              FLT has taken ${liability.usd} across {liability.count} deposit
              {liability.count === 1 ? '' : 's'} and not yet delivered it.
            </Notice>
          ) : null}

          {toDeliver.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-[var(--text-muted)]">
              Nothing owed.
            </p>
          ) : (
            toDeliver.map((row) => {
              const hash = (txHash[row.id] ?? '').trim();
              const ready = /^0x[0-9a-fA-F]{64}$/.test(hash) && Boolean(row.walletAddress);

              return (
                <div
                  key={row.id}
                  className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="num text-[13px] font-medium text-[var(--text)]">
                        {row.reference}
                      </p>
                      <p className="truncate text-[11px] text-[var(--text-subtle)]">
                        {row.email}
                        {row.bankReference ? ` · matched ${row.bankReference}` : ''}
                      </p>
                    </div>
                    <span className="num shrink-0 text-[14px] font-semibold text-[var(--text)]">
                      ${row.netUsd}
                    </span>
                  </div>

                  <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-sunken)] p-2">
                    <p className="text-[10px] uppercase tracking-[0.06em] text-[var(--text-subtle)]">
                      Send to
                    </p>
                    <p className="num break-all font-mono text-[12px] text-[var(--text)]">
                      {row.walletAddress ?? 'No FLT wallet on this account'}
                    </p>
                  </div>

                  <Input
                    value={txHash[row.id] ?? ''}
                    onChange={(event) =>
                      setTxHash((current) => ({ ...current, [row.id]: event.target.value }))
                    }
                    placeholder="Transaction hash of the transfer you sent"
                    className="num"
                  />

                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!ready || busy !== null}
                    loading={busy === `${row.id}:deliver`}
                    onClick={() =>
                      void act(row.id, {
                        action: 'deliver',
                        txHash: hash,
                        address: row.walletAddress,
                        chainId: row.walletChainId,
                      })
                    }
                  >
                    Mark delivered
                  </Button>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
