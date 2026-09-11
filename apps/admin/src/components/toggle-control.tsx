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
/**
 * What each toggle actually does, said plainly.
 *
 * An operator disabling something should know its blast radius before
 * confirming, and the three cases differ: a token stops quoting, a provider
 * fails the whole route closed, a fee rule silently changes what customers pay.
 */
const DESCRIPTIONS: Record<'token' | 'provider' | 'fee', { enable: string; disable: string }> = {
  token: {
    disable:
      'This token disappears from markets and new quotes for it are refused. Existing client balances in it are unaffected — they remain on the ledger.',
    enable: 'This token becomes tradeable again and reappears in markets.',
  },
  provider: {
    disable:
      'Quoting through this provider stops immediately. If it is the active provider, quoting fails closed rather than routing elsewhere.',
    enable: 'This provider becomes available for routing again.',
  },
  fee: {
    disable:
      'This rule stops applying to new quotes. Pricing falls back to the next most specific rule, which may mean charging nothing. Quotes already priced by it are unaffected.',
    enable: 'This rule applies to new quotes again wherever it is the most specific match.',
  },
};

export function ToggleControl({
  endpoint,
  enabled,
  label,
  kind,
  action,
}: {
  endpoint: string;
  enabled: boolean;
  label: string;
  kind: 'token' | 'provider' | 'fee';
  /**
   * Merged into the request body.
   *
   * Routes whose payload is a discriminated union need their action named;
   * routes that take a bare `{ enabled, reason }` leave this out.
   */
  action?: string;
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
        body: JSON.stringify({ ...(action ? { action } : {}), enabled: !enabled, reason }),
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
              {DESCRIPTIONS[kind][enabled ? 'disable' : 'enable']}
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
