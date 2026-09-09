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

/**
 * The remittance corridor's commercial terms.
 *
 * The maximum is the control that matters most and is not presented as a
 * convenience: it bounds how much FLT can end up owing on a single transfer
 * between the inbound leg confirming and an operator paying out by hand. It is
 * the practical brake on the one half of this feature that cannot be
 * automated.
 */
export function RemittanceSettingsForm({
  initial,
}: {
  initial: {
    enabled: boolean;
    fxRate: string;
    feeBps: number;
    minUsd: string;
    maxUsd: string;
    currency: string;
  };
}) {
  const router = useRouter();

  const [enabled, setEnabled] = useState(initial.enabled);
  const [fxRate, setFxRate] = useState(initial.fxRate);
  const [feeBps, setFeeBps] = useState(String(initial.feeBps));
  const [minUsd, setMinUsd] = useState(initial.minUsd);
  const [maxUsd, setMaxUsd] = useState(initial.maxUsd);
  const [currency, setCurrency] = useState(initial.currency);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();

    if (enabled && !initial.enabled) {
      const ok = window.confirm(
        'Open the remittance corridor?\n\n' +
          'Participants will be able to send stablecoin and be owed fiat. Payouts are manual — ' +
          'every transfer becomes an obligation you settle by hand from your own EVC float.',
      );
      if (!ok) return;
    }

    setError(null);
    setSaved(false);
    setPending(true);

    try {
      const response = await fetch('/api/remittance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'settings',
          enabled,
          fxRate: fxRate.trim(),
          feeBps: Number(feeBps),
          minUsd: minUsd.trim(),
          maxUsd: maxUsd.trim(),
          currency: currency.trim().toUpperCase(),
        }),
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Remittance corridor</CardTitle>
        <StatusPill tone={initial.enabled ? 'positive' : 'neutral'}>
          {initial.enabled ? 'Open' : 'Closed'}
        </StatusPill>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {error ? <Notice tone="negative">{error}</Notice> : null}
          {saved ? <Notice tone="positive">Saved.</Notice> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Rate" description="Local currency units per 1 USD.">
              {(props) => (
                <Input
                  {...props}
                  value={fxRate}
                  onChange={(event) => setFxRate(event.target.value)}
                  inputMode="decimal"
                  className="num"
                />
              )}
            </Field>

            <Field label="Payout currency" description="Three-letter code, e.g. USD or SOS.">
              {(props) => (
                <Input
                  {...props}
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                  maxLength={3}
                  className="num"
                />
              )}
            </Field>

            <Field label="Fee (bps)" description="Taken off the dollars before conversion. 100 = 1%.">
              {(props) => (
                <Input
                  {...props}
                  value={feeBps}
                  onChange={(event) => setFeeBps(event.target.value.replace(/[^\d]/g, ''))}
                  inputMode="numeric"
                  className="num"
                />
              )}
            </Field>

            <Field label="Minimum (USD)" description="Below this a transfer costs more to settle than it earns.">
              {(props) => (
                <Input
                  {...props}
                  value={minUsd}
                  onChange={(event) => setMinUsd(event.target.value)}
                  inputMode="decimal"
                  className="num"
                />
              )}
            </Field>

            <Field
              label="Maximum (USD)"
              description="The most you can owe on one transfer before a human pays it out. Keep it inside what your EVC float covers."
            >
              {(props) => (
                <Input
                  {...props}
                  value={maxUsd}
                  onChange={(event) => setMaxUsd(event.target.value)}
                  inputMode="decimal"
                  className="num"
                />
              )}
            </Field>
          </div>

          <label className="flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="size-4 accent-[var(--text)]"
            />
            Open the corridor to participants
          </label>

          <Notice tone="warning" title="This is money transmission">
            Taking stablecoin and delivering fiat is a different regulated activity from operating
            an exchange, and it is the only place FLT holds a participant&apos;s money. Open it only
            once the licensing, the beneficiary screening and the float are all actually in place.
          </Notice>

          <Button type="submit" variant="primary" loading={pending}>
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
