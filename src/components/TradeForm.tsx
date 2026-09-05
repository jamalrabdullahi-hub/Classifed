'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  api,
  newIdempotencyKey,
  type OrderView,
  type QuoteBreakdown,
} from './api';

/**
 * Buy/sell in one component: enter an amount, see a live quote with its fee and
 * countdown, confirm.
 *
 * Two things matter here beyond the layout:
 *   1. The confirm request sends only the quote id and an idempotency key. No
 *      amount, rate or fee is sent from the browser — the server re-derives all
 *      of it from the quote it priced.
 *   2. The idempotency key is generated once per quote, so a double-click or a
 *      retry on a flaky connection cannot place a second order.
 */
export function TradeForm({
  symbol,
  side,
  availableUsd,
  availableCrypto,
  quoteScale,
}: {
  symbol: string;
  side: 'BUY' | 'SELL';
  availableUsd: string;
  availableCrypto: string;
  quoteScale: number;
}) {
  const router = useRouter();
  const isBuy = side === 'BUY';

  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<QuoteBreakdown | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef<string | null>(null);

  const requestQuote = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const body = isBuy
        ? { assetSymbol: symbol, side, fiatAmount: amount }
        : { assetSymbol: symbol, side, cryptoAmount: amount };
      const result = await api.post<QuoteBreakdown>('/api/quotes', body);
      setQuote(result);
      setSecondsLeft(result.expiresInSeconds);
      // One key per quote: retries of THIS confirmation are deduplicated,
      // while a genuinely new quote gets a fresh key.
      idempotencyKey.current = newIdempotencyKey();
    } catch (err) {
      setQuote(null);
      setError(err instanceof ApiRequestError ? err.message : 'Could not price that amount');
    } finally {
      setBusy(false);
    }
  }, [amount, isBuy, side, symbol]);

  // Count the quote down and drop it when it expires. A stale price must never
  // sit on screen looking actionable.
  useEffect(() => {
    if (!quote) return;
    const timer = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          setQuote(null);
          idempotencyKey.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [quote]);

  async function confirm() {
    if (!quote || !idempotencyKey.current) return;
    setError(null);
    setBusy(true);
    try {
      const result = await api.post<OrderView>(
        '/api/orders',
        { quoteId: quote.id },
        idempotencyKey.current,
      );
      setOrder(result);
      setQuote(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'The order could not be placed');
      setQuote(null);
    } finally {
      setBusy(false);
    }
  }

  if (order) {
    return <OrderResult order={order} symbol={symbol} quoteScale={quoteScale} />;
  }

  return (
    <>
      <h1>
        {isBuy ? 'Buy' : 'Sell'} {symbol}
      </h1>
      <p className="muted">
        Available: {isBuy ? `$${availableUsd}` : `${availableCrypto} ${symbol}`}
      </p>

      {error ? <p className="error">{error}</p> : null}

      <label>
        <span>{isBuy ? 'Amount in USD' : `Amount in ${symbol}`}</span>
        <input
          inputMode="decimal"
          value={amount}
          placeholder={isBuy ? '100.00' : `0.${'0'.repeat(Math.min(quoteScale - 1, 5))}1`}
          onChange={(e) => {
            setAmount(e.target.value);
            setQuote(null);
          }}
        />
      </label>

      {!quote ? (
        <button
          type="button"
          className="primary"
          disabled={busy || !amount}
          onClick={requestQuote}
        >
          {busy ? 'Getting price…' : 'Get quote'}
        </button>
      ) : (
        <div className="card">
          <dl className="quote">
            <dt>Rate</dt>
            <dd>
              1 {symbol} = ${Number(quote.exchangeRate).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </dd>

            <dt>Brokerage fee</dt>
            <dd>${quote.brokerageFee}</dd>

            {Number(quote.networkFee) > 0 ? (
              <>
                <dt>Network fee</dt>
                <dd>{quote.networkFee}</dd>
              </>
            ) : null}

            <dt>{isBuy ? `${symbol} you receive` : 'USD you receive'}</dt>
            <dd className="total">
              {isBuy ? `${quote.cryptoAmount} ${symbol}` : `$${quote.totalCustomerCost}`}
            </dd>

            <dt>{isBuy ? 'Total cost' : `${symbol} you sell`}</dt>
            <dd>{isBuy ? `$${quote.fiatAmount}` : `${quote.cryptoAmount} ${symbol}`}</dd>

            {/*
              The guarantee, stated plainly. If we cannot beat this the trade
              does not happen and the money comes straight back — which is a
              better outcome than a surprise fill, and worth saying out loud.
            */}
            <dt>Guaranteed minimum</dt>
            <dd>
              {isBuy
                ? `${trimZeros(quote.minOutputAmount)} ${symbol}`
                : `$${Number(quote.minOutputAmount).toFixed(2)}`}
            </dd>

            {quote.priceImpactBps > 0 ? (
              <>
                <dt>Price impact</dt>
                <dd className={quote.priceImpactBps > 50 ? 'neg' : undefined}>
                  {(quote.priceImpactBps / 100).toFixed(2)}%
                </dd>
              </>
            ) : null}
          </dl>

          <p className="muted">
            If the price moves so we cannot deliver at least{' '}
            {isBuy
              ? `${trimZeros(quote.minOutputAmount)} ${symbol}`
              : `$${Number(quote.minOutputAmount).toFixed(2)}`}
            , the order is cancelled and your money is returned.
          </p>

          <p className="muted countdown">Price valid for {secondsLeft}s</p>

          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={confirm}>
              {busy ? 'Placing…' : `Confirm ${isBuy ? 'purchase' : 'sale'}`}
            </button>
            <button type="button" disabled={busy} onClick={() => setQuote(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function OrderResult({
  order,
  symbol,
  quoteScale,
}: {
  order: OrderView;
  symbol: string;
  quoteScale: number;
}) {
  // The venue reports fills at full precision; the customer is credited at the
  // asset's settlement scale. Show them what actually landed in their balance.
  const credited = trimZeros(Number(order.filledCryptoAmount).toFixed(quoteScale));

  const failed = order.status === 'FAILED' || order.status === 'REFUNDED';
  const partial = Number(order.refundedFiatAmount) > 0 && !failed;

  return (
    <>
      <h1>{order.side === 'BUY' ? 'Purchase' : 'Sale'}</h1>

      {failed ? (
        <p className="error">
          {order.failureReason ?? 'The order could not be completed.'} Your funds have been
          returned to your balance.
        </p>
      ) : (
        <p className="ok">
          {order.side === 'BUY'
            ? `You bought ${credited} ${symbol}.`
            : `You sold ${credited} ${symbol}.`}
        </p>
      )}

      {partial ? (
        <p className="warn">
          Only part of your order could be filled. ${order.refundedFiatAmount} has been
          returned to your USD balance.
        </p>
      ) : null}

      <div className="card">
        <dl className="quote">
          <dt>Status</dt>
          <dd>{order.status}</dd>

          {order.executionPrice ? (
            <>
              <dt>Execution price</dt>
              <dd>${Number(order.executionPrice).toFixed(2)}</dd>
            </>
          ) : null}

          <dt>Fee</dt>
          <dd>${order.brokerageFee}</dd>

          {order.priceImpactBps ? (
            <>
              <dt>Price impact</dt>
              <dd>{(order.priceImpactBps / 100).toFixed(2)}%</dd>
            </>
          ) : null}

          {order.providerOrderId ? (
            <>
              <dt>Provider reference</dt>
              <dd className="muted">{order.providerOrderId}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <div className="actions">
        <a className="btn primary" href="/dashboard">
          Back to balances
        </a>
        <a className="btn" href="/transactions">
          Transactions
        </a>
      </div>
    </>
  );
}

/** Drop trailing zeros so a small holding does not read as a wall of noise. */
function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') || '0' : value;
}
