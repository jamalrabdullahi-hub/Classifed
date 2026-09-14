'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Notice, StatusPill } from '@flt/ui';

/**
 * The merchant number, and the switch that offers the rail at all.
 *
 * A change of number gets a confirmation for the same reason the reserve
 * address does: participants dial what they are shown, and money sent to the
 * wrong number is not recoverable by editing this field afterwards.
 */
export function EvcSettingsForm({
  initial,
}: {
  initial: { enabled: boolean; merchantNumber: string };
}) {
  const router = useRouter();

  const [enabled, setEnabled] = useState(initial.enabled);
  const [merchantNumber, setMerchantNumber] = useState(initial.merchantNumber);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const numberChanged = merchantNumber.trim() !== initial.merchantNumber;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();

    if (numberChanged) {
      const ok = window.confirm(
        `Change the EVC merchant number to ${merchantNumber.trim()}?\n\n` +
          'Every payment from here on is dialled to this number. Payments already made to the ' +
          'old number are not affected by this change.',
      );
      if (!ok) return;
    }

    setError(null);
    setSaved(false);
    setPending(true);

    try {
      const response = await fetch('/api/evc-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ enabled, merchantNumber: merchantNumber.trim() }),
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
        <CardTitle>EVC Plus</CardTitle>
        <StatusPill tone={initial.enabled ? 'positive' : 'neutral'}>
          {initial.enabled ? 'Offered at checkout' : 'Off'}
        </StatusPill>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {error ? <Notice tone="negative">{error}</Notice> : null}
          {saved ? <Notice tone="positive">Saved.</Notice> : null}

          <Field
            label="Merchant number"
            description="Digits only. Participants dial *798*<this number>*<amount>*<cents>#."
          >
            {(props) => (
              <Input
                {...props}
                value={merchantNumber}
                onChange={(event) => setMerchantNumber(event.target.value.replace(/[^\d]/g, ''))}
                inputMode="numeric"
                className="num"
              />
            )}
          </Field>

          <label className="flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="size-4 accent-[var(--text)]"
            />
            Offer EVC Plus at checkout
          </label>

          <p className="text-[12px] leading-relaxed text-[var(--text-subtle)]">
            EVC gives FLT no way to verify a payment, so nothing here activates a plan on its own.
            Every claim lands in the queue below and starts a subscription only when someone
            confirms it against the merchant statement.
          </p>

          <Button type="submit" variant="primary" loading={pending}>
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
