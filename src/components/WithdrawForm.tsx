'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  api,
  newIdempotencyKey,
  type WalletView,
  type WithdrawalView,
} from './api';

/**
 * Crypto withdrawal: choose a saved wallet, request, confirm with a code.
 *
 * The confirmation step is the point of the whole screen — funds are only put
 * on hold, and only leave, after the code is verified server-side.
 */
export function WithdrawForm({
  assets,
  wallets,
  initialSymbol,
}: {
  assets: { symbol: string; quoteScale: number; available: string; minWithdrawal: string }[];
  wallets: WalletView[];
  initialSymbol: string;
}) {
  const router = useRouter();
  const [symbol, setSymbol] = useState(initialSymbol);
  const [amount, setAmount] = useState('');
  const [walletId, setWalletId] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [withdrawal, setWithdrawal] = useState<WithdrawalView | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef<string | null>(null);

  const asset = assets.find((a) => a.symbol === symbol);
  const assetWallets = wallets.filter((w) => w.assetSymbol === symbol);

  useEffect(() => {
    setWalletId(assetWallets[0]?.id ?? '');
  }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll an in-flight withdrawal until it settles.
  useEffect(() => {
    if (!withdrawal) return;
    const done = ['COMPLETED', 'FAILED', 'CANCELLED', 'REVERSED'];
    if (done.includes(withdrawal.status) || withdrawal.status === 'AWAITING_CONFIRMATION') {
      if (done.includes(withdrawal.status)) router.refresh();
      return;
    }

    const timer = setInterval(async () => {
      try {
        setWithdrawal(await api.get<WithdrawalView>(`/api/withdrawals/${withdrawal.id}`));
      } catch {
        // Transient; try again on the next tick.
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [withdrawal, router]);

  async function addWallet() {
    setError(null);
    setBusy(true);
    try {
      const wallet = await api.post<WalletView>('/api/wallets', {
        assetSymbol: symbol,
        address: newAddress,
      });
      wallets.push(wallet);
      setWalletId(wallet.id);
      setNewAddress('');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'That address could not be saved');
    } finally {
      setBusy(false);
    }
  }

  async function request(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    idempotencyKey.current ??= newIdempotencyKey();
    try {
      const result = await api.post<WithdrawalView>(
        '/api/withdrawals',
        { assetSymbol: symbol, amount, walletId },
        idempotencyKey.current,
      );
      setWithdrawal(result);
      // The dev build returns the code so the flow is walkable locally.
      if (result.confirmationCode) setCode(result.confirmationCode);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'The withdrawal could not be started');
      idempotencyKey.current = null;
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!withdrawal) return;
    setError(null);
    setBusy(true);
    try {
      setWithdrawal(
        await api.post<WithdrawalView>(`/api/withdrawals/${withdrawal.id}/confirm`, { code }),
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'The withdrawal could not be confirmed');
    } finally {
      setBusy(false);
    }
  }

  if (withdrawal) {
    const awaiting = withdrawal.status === 'AWAITING_CONFIRMATION';
    return (
      <>
        <h1>Withdraw {withdrawal.assetSymbol}</h1>

        {error ? <p className="error">{error}</p> : null}

        {withdrawal.status === 'COMPLETED' ? (
          <p className="ok">
            Sent. {withdrawal.netAmount} {withdrawal.assetSymbol} is on its way.
          </p>
        ) : withdrawal.status === 'FAILED' ? (
          <p className="error">
            {withdrawal.failureReason ?? 'The withdrawal failed.'} Your funds have been
            returned to your balance.
          </p>
        ) : awaiting ? (
          <p className="warn">
            Enter the 6-digit confirmation code to authorise this withdrawal.
          </p>
        ) : (
          <p className="warn">
            Sending… {withdrawal.confirmations}/{withdrawal.requiredConfirmations}{' '}
            confirmations.
          </p>
        )}

        <div className="card">
          <dl className="quote">
            <dt>Amount debited</dt>
            <dd>
              {withdrawal.amount} {withdrawal.assetSymbol}
            </dd>
            <dt>Network fee</dt>
            <dd>
              {withdrawal.networkFee} {withdrawal.assetSymbol}
            </dd>
            <dt>Arriving</dt>
            <dd className="total">
              {withdrawal.netAmount} {withdrawal.assetSymbol}
            </dd>
            <dt>To</dt>
            <dd className="muted" style={{ wordBreak: 'break-all' }}>
              {withdrawal.destinationAddress}
            </dd>
            {withdrawal.txHash ? (
              <>
                <dt>Transaction</dt>
                <dd className="muted" style={{ wordBreak: 'break-all' }}>
                  {withdrawal.txHash}
                </dd>
              </>
            ) : null}
          </dl>
        </div>

        {awaiting ? (
          <>
            <label>
              <span>Confirmation code</span>
              <input
                inputMode="numeric"
                value={code}
                maxLength={6}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={busy || code.length !== 6}
                onClick={confirm}
              >
                {busy ? 'Confirming…' : 'Confirm withdrawal'}
              </button>
              <a className="btn" href="/dashboard">
                Cancel
              </a>
            </div>
          </>
        ) : (
          <a className="btn primary" href="/dashboard">
            Back to balances
          </a>
        )}
      </>
    );
  }

  return (
    <form onSubmit={request}>
      <h1>Withdraw crypto</h1>
      {error ? <p className="error">{error}</p> : null}

      <label>
        <span>Asset</span>
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {assets.map((a) => (
            <option key={a.symbol} value={a.symbol}>
              {a.symbol} — {a.available} available
            </option>
          ))}
        </select>
      </label>

      <label>
        <span>
          Amount{asset ? ` (minimum ${asset.minWithdrawal} ${symbol})` : ''}
        </span>
        <input
          inputMode="decimal"
          value={amount}
          required
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>

      {assetWallets.length > 0 ? (
        <label>
          <span>Destination wallet</span>
          <select value={walletId} onChange={(e) => setWalletId(e.target.value)}>
            {assetWallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label ? `${w.label} — ` : ''}
                {w.address}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="muted">No saved {symbol} wallet yet. Add one below.</p>
      )}

      <div className="card">
        <label>
          <span>Add a {symbol} address</span>
          <input
            value={newAddress}
            placeholder="Paste the destination address"
            onChange={(e) => setNewAddress(e.target.value)}
          />
        </label>
        <button type="button" disabled={busy || !newAddress} onClick={addWallet}>
          Save address
        </button>
        <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
          Withdrawals can only be sent to a saved address.
        </p>
      </div>

      <button type="submit" className="primary" disabled={busy || !walletId || !amount}>
        {busy ? 'Checking…' : 'Continue'}
      </button>
    </form>
  );
}
