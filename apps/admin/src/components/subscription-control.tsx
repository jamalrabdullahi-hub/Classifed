'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Notice,
} from '@flt/ui';

/**
 * Grants a subscription period without a payment.
 *
 * This is an override, not a purchase — `grantSubscription` on the core side
 * refuses FREE (nothing to grant) and requires a reason, which lands in both
 * the admin action log and the general audit trail. Kept as its own control
 * rather than folded into `TierControl`: that one changes pricing (what an
 * account is charged); this one changes entitlements (what an account can
 * do) — the same distinction that keeps suspension and trading separate.
 */
const TIERS = ['BASIC', 'PRO', 'ELITE'] as const;

export function SubscriptionControl({
  userId,
  currentTier,
  currentEndsAt,
}: {
  userId: string;
  currentTier: string;
  currentEndsAt: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState<(typeof TIERS)[number]>('BASIC');
  const [days, setDays] = useState('30');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const response = await fetch(`/api/users/${userId}/subscription`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ tier, days: Number(days), reason }),
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? 'Could not grant this plan.');
        return;
      }

      setOpen(false);
      setReason('');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-[var(--text)]">
          {currentTier}
          {currentEndsAt ? (
            <span className="ml-1.5 text-[11px] text-[var(--text-subtle)]">
              until {new Date(currentEndsAt).toLocaleDateString()}
            </span>
          ) : null}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Grant plan
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Grant a subscription</DialogTitle>
              <DialogDescription>
                No payment is recorded. Entitlements apply exactly as they would for a paid
                period — the account cannot tell the difference, only this operator log can.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-4">
              {error ? <Notice tone="negative">{error}</Notice> : null}

              <Field label="Plan">
                {(props) => (
                  <select
                    {...props}
                    value={tier}
                    onChange={(event) => setTier(event.target.value as (typeof TIERS)[number])}
                    className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--text)]"
                  >
                    {TIERS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label="Length, in days">
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    max={3650}
                    value={days}
                    onChange={(event) => setDays(event.target.value)}
                    required
                  />
                )}
              </Field>

              <Field label="Reason" description="Recorded in the operator log.">
                {(props) => (
                  <Input
                    {...props}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Internal test account"
                    required
                  />
                )}
              </Field>
            </DialogBody>

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy} disabled={reason.trim().length < 3}>
                Grant
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
