'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Notice } from '@flt/ui';

/**
 * Allocate custodied capital to an account.
 *
 * Posts a real ledger `ADJUSTMENT` (see `admin.adjustClientBalance`): it grants
 * spendable buying power and is recorded against the operator. This is money,
 * not a note, so the form says so and every field is required — an allocation
 * with no reason cannot be reviewed later, and the server refuses one.
 */
export function LedgerAdjustmentForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [asset, setAsset] = useState('USDC');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const valid =
    email.trim().length > 0 &&
    asset.trim().length > 0 &&
    /^\d+(\.\d+)?$/.test(amount.trim()) &&
    reason.trim().length >= 8;

  async function submit() {
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      const response = await fetch('/api/ledger/adjustments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          email: email.trim(),
          asset: asset.trim(),
          amount: amount.trim(),
          reason,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? 'Could not allocate.');
        return;
      }

      const credited = payload?.data?.credited ?? amount.trim();
      const symbol = payload?.data?.asset ?? asset.trim().toUpperCase();
      setDone(`Credited ${credited} ${symbol} to ${email.trim()}.`);
      setAmount('');
      setReason('');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Allocate capital</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          Credits a real, audited ledger balance from the omnibus — it grants spendable buying power
          and is recorded as an <span className="font-mono">ADJUSTMENT</span> against your admin
          account. The omnibus is debited by the same amount, so reconciliation still balances.
        </p>

        {error ? <Notice tone="negative">{error}</Notice> : null}
        {done ? <Notice tone="positive">{done}</Notice> : null}

        <Field label="Account email" required>
          {(props) => (
            <Input
              {...props}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="user@example.com"
            />
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Asset" required>
            {(props) => (
              <Input
                {...props}
                value={asset}
                onChange={(event) => setAsset(event.target.value)}
                placeholder="USDC"
              />
            )}
          </Field>
          <Field label="Amount" description="Human units, e.g. 1 or 1.50" required>
            {(props) => (
              <Input
                {...props}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="1.00"
                inputMode="decimal"
              />
            )}
          </Field>
        </div>

        <Field
          label="Reason"
          description="At least 8 characters — recorded in the audit trail against your account."
          required
        >
          {(props) => (
            <Input {...props} value={reason} onChange={(event) => setReason(event.target.value)} />
          )}
        </Field>

        <Button variant="primary" onClick={submit} loading={busy} disabled={!valid}>
          Credit account
        </Button>
      </CardContent>
    </Card>
  );
}
