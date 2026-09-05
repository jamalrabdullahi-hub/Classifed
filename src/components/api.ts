'use client';

/**
 * Tiny client for the JSON API.
 *
 * Every mutating call sends an Idempotency-Key. That is not optional politeness:
 * a customer double-clicking Confirm on a slow connection is the single most
 * likely way to place two orders, and the key is what makes the second one a
 * no-op rather than a second purchase.
 */

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: ApiError;
  };

  if (!response.ok) {
    const error = payload.error;
    throw new ApiRequestError(
      error?.code ?? 'UNKNOWN',
      error?.message ?? 'Something went wrong',
      response.status,
      error?.details,
    );
  }

  return payload.data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body?: unknown, idempotencyKey?: string) =>
    request<T>('POST', path, body ?? {}, idempotencyKey),
};

// --- Shared response shapes -------------------------------------------------

export interface Balance {
  symbol: string;
  name: string;
  kind: 'FIAT' | 'CRYPTO';
  quoteScale: number;
  available: string;
  held: string;
  total: string;
}

export interface QuoteBreakdown {
  id: string;
  assetSymbol: string;
  side: 'BUY' | 'SELL';
  fiatAmount: string;
  cryptoAmount: string;
  exchangeRate: string;
  brokerageFee: string;
  networkFee: string;
  totalCustomerCost: string;
  /** The floor we will enforce on-chain. Below this the order fails and refunds. */
  minOutputAmount: string;
  /** Price impact of sourcing this size, in basis points. */
  priceImpactBps: number;
  expiresAt: string;
  expiresInSeconds: number;
}

export interface OrderView {
  id: string;
  status: string;
  side: 'BUY' | 'SELL';
  assetSymbol: string | null;
  requestedFiatAmount: string;
  filledCryptoAmount: string;
  filledFiatAmount: string;
  refundedFiatAmount: string;
  brokerageFee: string;
  executionPrice: string | null;
  providerOrderId: string | null;
  failureReason: string | null;
  executionVenue: 'INVENTORY' | 'DEX' | 'OTC' | null;
  priceImpactBps: number | null;
  trades: {
    id: string;
    sequence: number;
    quantity: string;
    executedPrice: string;
    fiatValue: string;
  }[];
}

export interface DepositView {
  id: string;
  status: string;
  amount: string;
  providerFee: string;
  netAmount: string;
  failureReason: string | null;
}

export interface WithdrawalView {
  id: string;
  status: string;
  assetSymbol: string | null;
  amount: string;
  networkFee: string;
  netAmount: string;
  destinationAddress: string | null;
  txHash: string | null;
  confirmations: number;
  requiredConfirmations: number;
  failureReason: string | null;
  confirmationCode?: string;
}

export interface WalletView {
  id: string;
  assetSymbol: string;
  network: string;
  address: string;
  label: string | null;
}
