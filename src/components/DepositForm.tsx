'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, api, newIdempotencyKey, type DepositView } from './api';

/**
 * USD deposit through the payment provider.
 *
 * After the request is created the customer approves it on their phone, and we
 * poll. The polling endpoint re-verifies with the provider rather than trusting
 * any client-side claim that payment happened.
 */
export function DepositForm({ defaultPhone }: { defaultPhone: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState(defaultPhone);
  const [deposit, setDeposit] = useState<DepositView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef<string | null>(null);

  // Poll until the deposit reaches a terminal state.
  useEffect(() => {
    if (!deposit) return;
    if (deposit.status === 'CREDITED' || deposit.status === 'FAILED') {
      router.refresh();
      return;
    }

    const timer = setInterval(async () => {
      try {
        const updated = await api.get<DepositView>(`/api/deposits/${deposit.id}`);
        setDeposit(updated);
      } catch {
        // Transient; the next tick tries again.
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [deposit, router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    idempotencyKey.current ??= newIdempotencyKey();
    try {
      const result = await api.post<DepositView>(
        '/api/deposits',
        { amount, payerAccountRef: phone },
        idempotencyKey.current,
      );
      setDeposit(result);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'The deposit could not be started');
      // A new attempt is a new request, so it needs a new key.
      idempotencyKey.current = null;
    } finally {
      setBusy(false);
    }
  }

  if (deposit) {
    return (
      <>
        <h1>Deposit</h1>

        {deposit.status === 'CREDITED' ? (
          <p className="ok">
            ${deposit.netAmount} has been added to your balance.
            {Number(deposit.providerFee) > 0
              ? ` A provider fee of $${deposit.providerFee} was deducted.`
              : ''}
          </p>
        ) : deposit.status === 'FAILED' ? (
          <p className="error">{deposit.failureReason ?? 'The payment was not completed.'}</p>
        ) : (
          <p className="warn">
            Approve the payment request for ${deposit.amount} on {phone}. This page updates
            automatically.
          </p>
        )}

        <div className="card">
          <dl className="quote">
            <dt>Status</dt>
            <dd>{deposit.status}</dd>
            <dt>Amount</dt>
            <dd>${deposit.amount}</dd>
          </dl>
        </div>

        <div className="actions">
          <a className="btn primary" href="/dashboard">
            Back to balances
          </a>
          {deposit.status === 'FAILED' ? (
            <button
              type="button"
              onClick={() => {
                setDeposit(null);
                idempotencyKey.current = null;
              }}
            >
              Try again
            </button>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <form onSubmit={submit}>
      <h1>Deposit USD</h1>
      {error ? <p className="error">{error}</p> : null}

      <label>
        <span>Amount in USD</span>
        <input
          inputMode="decimal"
          value={amount}
          required
          placeholder="100.00"
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>

      <label>
        <span>Mobile number to pay from</span>
        <input
          type="tel"
          value={phone}
          required
          placeholder="+252612345678"
          onChange={(e) => setPhone(e.target.value)}
        />
      </label>

      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Starting…' : 'Continue'}
      </button>
    </form>
  );
}
