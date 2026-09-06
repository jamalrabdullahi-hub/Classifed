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
 * Moves a customer between pricing tiers.
 *
 * The tier decides what this account is charged, nothing else — it does not
 * grant access, raise limits or change what they can trade. Kept separate from
 * suspension and trading for that reason: those are access decisions and this
 * is a commercial one, and an operator should not be able to reach for the
 * wrong control by accident.
 */
const TIERS = ['INVESTOR', 'TRADER', 'INSTITUTION'] as const;

export function TierControl({ userId, current }: { userId: string; current: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState(current);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const response = await fetch(`/api/users/${userId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'tier', accountType: tier, reason }),
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? 'Could not change the tier.');
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
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Change tier
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Change pricing tier</DialogTitle>
              <DialogDescription>
                Affects what this account is charged on every future quote. Existing quotes keep
                the rate they were priced at.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-4">
              {error ? <Notice tone="negative">{error}</Notice> : null}

              <Field label="Tier">
                {(props) => (
                  <select
                    {...props}
                    value={tier}
                    onChange={(event) => setTier(event.target.value)}
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

              <p className="text-[12px] leading-relaxed text-[var(--text-subtle)]">
                A tier only changes pricing where a fee rule names it. Without such a rule the
                account keeps paying the default.
              </p>

              <Field label="Reason" description="Recorded in the operator log.">
                {(props) => (
                  <Input
                    {...props}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Negotiated institutional pricing"
                    required
                  />
                )}
              </Field>
            </DialogBody>

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy} disabled={tier === current}>
                Change tier
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
