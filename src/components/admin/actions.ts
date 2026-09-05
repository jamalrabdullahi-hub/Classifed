'use client';

/**
 * Shared POST helper for operator actions.
 *
 * Admin mutations are not idempotency-keyed the way customer money movements
 * are: they change decision state, not balances, and the services behind them
 * are guarded (an approval updates only while still PENDING, a KYC verdict goes
 * through the state machine). A double click therefore fails loudly on the
 * second attempt rather than doing the thing twice.
 */
export async function adminPost(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;

  if (!response.ok) {
    throw new Error(payload?.error?.message ?? 'The request failed');
  }
}
