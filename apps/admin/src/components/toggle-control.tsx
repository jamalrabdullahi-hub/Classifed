'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
 * Enable/disable control for a token or a routing provider.
 *
 * Shared by both because the interaction is identical: confirm, give a reason,
 * apply. The reason is required in both directions — re-enabling something that
 * was disabled for a reason is as worth recording as the disabling was.
 */
export function ToggleControl({
  endpoint,
  enabled,
  label,
  kind,
}: {
  endpoint: string;
  enabled: boolean;
  label: string;
  kind: 'token' | 'provider';
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply() {
    setError(null);
    setBusy(true);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ enabled: !enabled, reason }),
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? 'Could not apply the change.');
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
      <Button
        variant={enabled ? 'secondary' : 'primary'}
        size="sm"
        onClick={() => {
          setOpen(true);
          setReason('');
          setError(null);
        }}
      >
        {enabled ? 'Disable' : 'Enable'}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {enabled ? 'Disable' : 'Enable'} {label}
            </DialogTitle>
            <DialogDescription>
              {enabled
                ? kind === 'token'
                  ? 'This token disappears from markets and new quotes for it are refused. Existing on-chain balances are unaffected — FLT does not hold them.'
                  : 'Quoting through this provider stops immediately. If it is the active provider, quoting fails closed rather than routing elsewhere.'
                : kind === 'token'
                  ? 'This token becomes tradeable again and reappears in markets.'
                  : 'This provider becomes available for routing again.'}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {error ? <Notice tone="negative">{error}</Notice> : null}

            <Field
              label="Reason"
              description="Recorded in the audit trail, and shown to users when a disabled item is requested."
              required
            >
              {(props) => (
                <Input
                  {...props}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={enabled ? 'Liquidity below threshold' : 'Reviewed and reinstated'}
                  autoFocus
                />
              )}
            </Field>
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={enabled ? 'danger' : 'primary'}
              onClick={apply}
              loading={busy}
              disabled={reason.trim().length < 8}
            >
              {enabled ? 'Disable' : 'Enable'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
