'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Notice } from '@flt/ui';

/**
 * Protection settings.
 *
 * The reserve address gets its own confirmation because it is the field that
 * cannot be undone: once participants have paid into an address, changing it
 * does not move what is already there. Everything else is an ordinary edit.
 */
export function ProtectionSettingsForm({
  initial,
}: {
  initial: {
    reserveAddress: string | null;
    operatorAddress: string | null;
    operatorFeeBps: number;
    creditDestination: 'BALANCE' | 'POSITION';
    allowCreditChoice: boolean;
    mode: 'off' | 'optional' | 'required';
  };
}) {
  const router = useRouter();

  const [reserveAddress, setReserveAddress] = useState(initial.reserveAddress ?? '');
  const [operatorAddress, setOperatorAddress] = useState(initial.operatorAddress ?? '');
  const [operatorFeeBps, setOperatorFeeBps] = useState(String(initial.operatorFeeBps));
  const [creditDestination, setCreditDestination] = useState(initial.creditDestination);
  const [allowCreditChoice, setAllowCreditChoice] = useState(initial.allowCreditChoice);
  const [mode, setMode] = useState(initial.mode);
  const [reason, setReason] = useState('');

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const reserveChanged =
    reserveAddress.trim().toLowerCase() !== (initial.reserveAddress ?? '').toLowerCase();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();

    if (reserveChanged) {
      const ok = window.confirm(
        'Change the reserve address?\n\n' +
          'Participant contributions will go to the new address from the next purchase. ' +
          'Funds already held at the old address are not moved by this change.',
      );
      if (!ok) return;
    }

    setError(null);
    setPending(true);
    setSaved(false);

    try {
      const response = await fetch('/api/protection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reserveAddress: reserveAddress.trim(),
          operatorAddress: operatorAddress.trim(),
          operatorFeeBps: Number(operatorFeeBps),
          creditDestination,
          allowCreditChoice,
          mode,
          reason,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? 'Could not save the settings');
      }

      setSaved(true);
      setReason('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the settings');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error ? <Notice tone="negative">{error}</Notice> : null}
      {saved ? <Notice tone="positive">Settings saved.</Notice> : null}

      <Field
        label="Reserve wallet"
        description="Where participants' contributions are sent. Must differ from the fee address."
      >
        {(props) => (
          <Input
            {...props}
            value={reserveAddress}
            onChange={(event) => setReserveAddress(event.target.value)}
            placeholder="0x…"
            className="num"
          />
        )}
      </Field>

      <Field label="Fee wallet" description="Where FLT's management fee is sent.">
        {(props) => (
          <Input
            {...props}
            value={operatorAddress}
            onChange={(event) => setOperatorAddress(event.target.value)}
            placeholder="0x…"
            className="num"
          />
        )}
      </Field>

      <Field
        label="Management fee (bps)"
        description="Basis points of the contribution, charged on top of it. 1000 = 10%."
      >
        {(props) => (
          <Input
            {...props}
            value={operatorFeeBps}
            onChange={(event) => setOperatorFeeBps(event.target.value.replace(/[^\d]/g, ''))}
            inputMode="numeric"
            className="num"
          />
        )}
      </Field>

      <Field
        label="Credit routing"
        description="Where credit from a repriced or ended policy goes by default."
      >
        {(props) => (
          <select
            {...props}
            value={creditDestination}
            onChange={(event) =>
              setCreditDestination(event.target.value as 'BALANCE' | 'POSITION')
            }
            className="w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-transparent px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
          >
            <option value="BALANCE">Stablecoin balance in profile</option>
            <option value="POSITION">Returned to the position as margin</option>
          </select>
        )}
      </Field>

      <label className="flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
        <input
          type="checkbox"
          checked={allowCreditChoice}
          onChange={(event) => setAllowCreditChoice(event.target.checked)}
          className="size-4 accent-[var(--text)]"
        />
        Let participants choose their own routing
      </label>

      <Field
        label="Mode"
        description="Required gates leveraged trading on holding cover."
      >
        {(props) => (
          <select
            {...props}
            value={mode}
            onChange={(event) => setMode(event.target.value as typeof mode)}
            className="w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-transparent px-3 py-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
          >
            <option value="off">Off — not sold</option>
            <option value="optional">Optional</option>
            <option value="required">Required for leverage</option>
          </select>
        )}
      </Field>

      <Field label="Reason" description="Recorded in the audit trail.">
        {(props) => (
          <Input
            {...props}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why this change is being made"
            required
          />
        )}
      </Field>

      <Button type="submit" variant="primary" loading={pending} disabled={!reason.trim()}>
        Save settings
      </Button>
    </form>
  );
}
