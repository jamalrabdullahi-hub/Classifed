'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Notice } from '@flt/ui';
import { DepositTimeline } from './deposit-timeline';

export interface DepositRow {
  id: string;
  email: string;
  method: string;
  currency: string;
  amountFiat: string;
  netUsd: string | null;
  reference: string;
  status: string;
  payerName: string;
  payerPhone: string;
  omnibusAddress: string | null;
  omnibusChainId: number;
  bankReference: string | null;
  deliveryTxHash: string | null;
  createdAt: string;
  receivedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
}

/**
 * A deposit's four operator stages.
 *
 * Three queues rather than one list, because they are three different jobs
 * done at different moments: reconciling a bank statement, converting the cash
 * into the custodied stablecoin, and confirming it landed in the omnibus. An
 * operator working the third queue is crediting money already owed, which is
 * why the outstanding figure sits above it.
 *
 * Every row carries its timeline, so a deposit stuck for three days does not
 * look identical to one raised ten minutes ago — which is exactly what a flat
 * "pending" list does.
 */
export function FiatDepositQueue({
  awaiting,
  toSend,
  toConfirm,
  liability,
  defaultTokenAddress,
  defaultTreasuryAddress,
}: {
  awaiting: DepositRow[];
  toSend: DepositRow[];
  toConfirm: DepositRow[];
  liability: { count: number; usd: string };
  defaultTokenAddress: string | null;
  defaultTreasuryAddress: string | null;
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

  function timelineFor(row: DepositRow) {
    return (
      <DepositTimeline
        reference={row.reference}
        stages={[
          { label: 'Deposit initiated', at: row.createdAt },
          {
            label: 'Confirm reconciliation',
            at: row.receivedAt,
            note: row.bankReference,
          },
          {
            label: 'Confirm conversion into the omnibus',
            at: row.sentAt,
            note: row.deliveryTxHash ? `${row.deliveryTxHash.slice(0, 14)}…` : null,
          },
          { label: 'Confirm on-chain and credit the balance', at: row.deliveredAt },
        ]}
      />
    );
  }

  function header(row: DepositRow) {
    return (
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-[var(--text)]">
            {row.payerName} <span className="num text-[var(--text-muted)]">{row.payerPhone}</span>
          </p>
          <p className="truncate text-[11px] text-[var(--text-subtle)]">
            {row.email} · {row.method}
          </p>
        </div>
        <span className="num shrink-0 text-[14px] font-semibold text-[var(--text)]">
          {row.netUsd ? `$${row.netUsd}` : `${row.amountFiat} ${row.currency}`}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error ? <Notice tone="negative">{error}</Notice> : null}

      {liability.count > 0 ? (
        <Notice tone="warning" title="Outstanding to participants">
          FLT has taken ${liability.usd} across {liability.count} deposit
          {liability.count === 1 ? '' : 's'} that has not yet been confirmed as delivered.
        </Notice>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>1 · Awaiting funds</CardTitle>
          <Badge tone={awaiting.length > 0 ? 'warning' : 'neutral'}>{awaiting.length}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {awaiting.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-[var(--text-muted)]">Nothing waiting.</p>
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
                  {header(row)}
                  {timelineFor(row)}

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
                      wrong one is a live risk. */}
                  <p className="text-[11px] text-[var(--text-subtle)]">
                    Enter what actually arrived — they said {row.amountFiat} {row.currency}.
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
                      Confirm reconciliation
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
          <CardTitle>2 · Convert into the omnibus</CardTitle>
          <Badge tone={toSend.length > 0 ? 'negative' : 'neutral'}>{toSend.length}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {toSend.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-[var(--text-muted)]">Nothing to send.</p>
          ) : (
            toSend.map((row) => {
              const hash = (txHash[row.id] ?? '').trim();
              const ready = /^0x[0-9a-fA-F]{64}$/.test(hash) && Boolean(row.omnibusAddress);

              return (
                <div
                  key={row.id}
                  className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] p-3"
                >
                  {header(row)}
                  {timelineFor(row)}

                  {/* Read-only. An operator retyping an address is the most
                      expensive mistake available here, and it is already
                      known. */}
                  <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-sunken)] p-2">
                    <p className="text-[10px] uppercase tracking-[0.06em] text-[var(--text-subtle)]">
                      Send converted stablecoin to
                    </p>
                    <p className="num break-all font-mono text-[12px] text-[var(--text)]">
                      {row.omnibusAddress ?? 'Custody is not configured — no omnibus wallet'}
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
                    loading={busy === `${row.id}:send`}
                    onClick={() =>
                      void act(row.id, {
                        action: 'send',
                        txHash: hash,
                        address: row.omnibusAddress,
                        chainId: row.omnibusChainId,
                      })
                    }
                  >
                    Confirm conversion
                  </Button>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3 · Confirm and credit</CardTitle>
          <Badge tone={toConfirm.length > 0 ? 'warning' : 'neutral'}>{toConfirm.length}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {toConfirm.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-[var(--text-muted)]">
              Nothing awaiting confirmation.
            </p>
          ) : (
            toConfirm.map((row) => (
              <div
                key={row.id}
                className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] p-3"
              >
                {header(row)}
                {timelineFor(row)}

                {/* This is the only step the chain verifies rather than an
                    operator asserting. It reads the receipt and refuses if the
                    token, sender, recipient or amount does not match. */}
                <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">
                  Checks the transaction against the chain before crediting. Refuses if the token,
                  sender, omnibus recipient or amount does not match what is owed.
                </p>

                <Button
                  variant="primary"
                  size="sm"
                  disabled={!defaultTokenAddress || !defaultTreasuryAddress || busy !== null}
                  loading={busy === `${row.id}:deliver`}
                  onClick={() =>
                    void act(row.id, {
                      action: 'deliver',
                      tokenAddress: defaultTokenAddress,
                      treasuryAddress: defaultTreasuryAddress,
                    })
                  }
                >
                  Verify on-chain and credit
                </Button>

                {!defaultTokenAddress || !defaultTreasuryAddress ? (
                  <Notice tone="warning">
                    Set the payment token and the fee wallet under Protection first — they are what
                    the on-chain check compares against.
                  </Notice>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
