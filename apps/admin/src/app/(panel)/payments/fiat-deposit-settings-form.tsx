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
 * The commercial terms of a fiat deposit, and the instructions participants
 * are shown.
 *
 * The instructions are free text because the right answer differs per rail and
 * per country — an ACH routing number, an IBAN, a mobile-money number — and a
 * form with the wrong boxes is worse than a paragraph with the right ones.
 * They reach participants verbatim, whitespace and all, so an address block
 * stays an address block rather than becoming prose.
 */
export function FiatDepositSettingsForm({
  initial,
}: {
  initial: { enabled: boolean; feeBps: number; minUsd: string; instructions: string };
}) {
  const router = useRouter();

  const [enabled, setEnabled] = useState(initial.enabled);
  const [feeBps, setFeeBps] = useState(String(initial.feeBps));
  const [minUsd, setMinUsd] = useState(initial.minUsd);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);

    try {
      const response = await fetch('/api/fiat-deposit-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          enabled,
          feeBps: Number(feeBps),
          minUsd: minUsd.trim(),
          instructions,
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
        <CardTitle>Fiat deposits</CardTitle>
        <StatusPill tone={initial.enabled ? 'positive' : 'neutral'}>
          {initial.enabled ? 'Open' : 'Closed'}
        </StatusPill>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {error ? <Notice tone="negative">{error}</Notice> : null}
          {saved ? <Notice tone="positive">Saved.</Notice> : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Fee (bps)" description="100 = 1% of the deposit.">
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

            <Field
              label="Minimum"
              description="Below this, the fee and the operator time cost more than the deposit is worth."
            >
              {(props) => (
                <Input
                  {...props}
                  value={minUsd}
                  onChange={(event) => setMinUsd(event.target.value.replace(/[^\d.]/g, ''))}
                  inputMode="decimal"
                  className="num"
                />
              )}
            </Field>
          </div>

          <Field
            label="Deposit instructions"
            description="Shown to participants exactly as written. Bank name, account, routing or IBAN, and anything else they need."
          >
            {(props) => (
              <textarea
                {...props}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                rows={8}
                className="w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
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
            Accept deposits
          </label>

          <p className="text-[12px] leading-relaxed text-[var(--text-subtle)]">
            Turning this on lets participants send real money. Neither leg is automatic: someone
            watches the account, and someone sends the crypto. Between those two a deposit is a
            debt FLT owes, shown in the queue below.
          </p>

          <Button type="submit" variant="primary" loading={pending}>
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
