'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Notice,
  StatusPill,
} from '@flt/ui';

export interface FiatRailSettingsView {
  wire: {
    enabled: boolean;
    bankName: string;
    accountName: string;
    accountNumber: string;
    routingNumber: string;
    swift: string;
    bankAddress: string;
  };
  paypal: { enabled: boolean; address: string };
  withdrawals: {
    enabled: boolean;
    feeBps: number;
    minUsd: string;
    evc: boolean;
    bank: boolean;
    paypal: boolean;
  };
}

/**
 * Cash rails: where participants send money, and the terms FLT pays out on.
 *
 * Every detail here is shown to participants and paid into, so each rail stays
 * closed until its details are complete — the server refuses to open a wire
 * rail with a half-written account number, and this form says why before it is
 * submitted.
 *
 * Card has no settings because there is nothing to configure without a payment
 * processor. It is listed so that is visible rather than a silent gap.
 */
export function FiatRailSettingsForm({ initial }: { initial: FiatRailSettingsView }) {
  const router = useRouter();
  const [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const setWire = (patch: Partial<FiatRailSettingsView['wire']>) =>
    setDraft((current) => ({ ...current, wire: { ...current.wire, ...patch } }));
  const setPaypal = (patch: Partial<FiatRailSettingsView['paypal']>) =>
    setDraft((current) => ({ ...current, paypal: { ...current.paypal, ...patch } }));
  const setWithdrawals = (patch: Partial<FiatRailSettingsView['withdrawals']>) =>
    setDraft((current) => ({ ...current, withdrawals: { ...current.withdrawals, ...patch } }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      const response = await fetch('/api/fiat-rail-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(draft),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Could not save this');
      setSaved(true);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save this');
    } finally {
      setPending(false);
    }
  }

  const text = (
    label: string,
    value: string,
    onChange: (next: string) => void,
    description?: string,
  ) => (
    <Field label={label} description={description}>
      {(props) => (
        <Input {...props} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </Field>
  );

  const toggle = (label: string, checked: boolean, onChange: (next: boolean) => void) => (
    <label className="flex items-center gap-2 text-[13px] text-[var(--text)]">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cash rails</CardTitle>
        <StatusPill tone={initial.withdrawals.enabled || initial.wire.enabled || initial.paypal.enabled ? 'positive' : 'neutral'}>
          {initial.withdrawals.enabled || initial.wire.enabled || initial.paypal.enabled ? 'Some open' : 'All closed'}
        </StatusPill>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-6">
          {error ? <Notice tone="negative">{error}</Notice> : null}
          {saved ? <Notice tone="positive">Saved.</Notice> : null}

          {/* ── Bank wire in ───────────────────────────────────────────── */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-[var(--text)]">Bank wire deposits</h3>
              {toggle('Accept wires', draft.wire.enabled, (enabled) => setWire({ enabled }))}
            </div>
            <p className="text-[12px] text-[var(--text-muted)]">
              Shown to participants on the deposit screen, with their reference to put on the transfer.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {text('Bank name', draft.wire.bankName, (bankName) => setWire({ bankName }))}
              {text('Account name', draft.wire.accountName, (accountName) => setWire({ accountName }))}
              {text('Account number or IBAN', draft.wire.accountNumber, (accountNumber) => setWire({ accountNumber }))}
              {text('Routing / ABA', draft.wire.routingNumber, (routingNumber) => setWire({ routingNumber }), 'For US wires.')}
              {text('SWIFT / BIC', draft.wire.swift, (swift) => setWire({ swift }), 'For international wires.')}
              {text('Bank address', draft.wire.bankAddress, (bankAddress) => setWire({ bankAddress }))}
            </div>
          </section>

          {/* ── PayPal in ──────────────────────────────────────────────── */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-[var(--text)]">PayPal deposits</h3>
              {toggle('Accept PayPal', draft.paypal.enabled, (enabled) => setPaypal({ enabled }))}
            </div>
            {text('PayPal address to receive at', draft.paypal.address, (address) => setPaypal({ address }))}
            <Notice tone="warning">
              PayPal restricts using its service to fund crypto purchases, and a payer can dispute a
              PayPal payment after you have credited them. Check your PayPal account terms before opening this.
            </Notice>
          </section>

          {/* ── Card ───────────────────────────────────────────────────── */}
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-[var(--text)]">Card (deposits and withdrawals)</h3>
              <StatusPill tone="neutral">Not connected</StatusPill>
            </div>
            <p className="text-[12px] text-[var(--text-muted)]">
              Needs a payment processor account. Card numbers are never collected directly — that
              would put FLT in PCI scope. Chargebacks after crypto is withdrawn are a real loss risk.
            </p>
          </section>

          {/* ── Cash out ───────────────────────────────────────────────── */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-[var(--text)]">Cash withdrawals (USD out)</h3>
              {toggle('Open withdrawals', draft.withdrawals.enabled, (enabled) => setWithdrawals({ enabled }))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Fee (bps)" description="100 = 1% of the withdrawal.">
                {(props) => (
                  <Input
                    {...props}
                    value={String(draft.withdrawals.feeBps)}
                    onChange={(event) =>
                      setWithdrawals({ feeBps: Number(event.target.value.replace(/[^\d]/g, '') || 0) })
                    }
                    inputMode="numeric"
                    className="num"
                  />
                )}
              </Field>
              <Field label="Minimum (USD)">
                {(props) => (
                  <Input
                    {...props}
                    value={draft.withdrawals.minUsd}
                    onChange={(event) => setWithdrawals({ minUsd: event.target.value.replace(/[^\d.]/g, '') })}
                    inputMode="decimal"
                    className="num"
                  />
                )}
              </Field>
            </div>
            <div className="flex flex-wrap gap-4">
              {toggle('To EVC', draft.withdrawals.evc, (evc) => setWithdrawals({ evc }))}
              {toggle('To bank account', draft.withdrawals.bank, (bank) => setWithdrawals({ bank }))}
              {toggle('To PayPal', draft.withdrawals.paypal, (paypal) => setWithdrawals({ paypal }))}
            </div>
          </section>

          <Button type="submit" variant="primary" loading={pending}>
            Save cash rails
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
