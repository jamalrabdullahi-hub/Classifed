'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Ban, CircleSlash, RotateCcw, ShieldCheck } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
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
 * Account controls.
 *
 * Every action opens a confirmation that requires a reason of at least eight
 * characters, matching what the API enforces. The dialog states plainly what
 * the action does to the user, so an operator is not guessing at the
 * consequence of a button labelled "suspend".
 */

type Action =
  | { kind: 'suspend'; suspended: boolean }
  | { kind: 'trading'; disabled: boolean }
  | { kind: 'approval'; approved: boolean };

export function UserControls({
  userId,
  suspended,
  tradingDisabled,
  tradingApproved,
  kycApproved,
  canSuspend,
  canToggleTrading,
}: {
  userId: string;
  suspended: boolean;
  tradingDisabled: boolean;
  /** The separate trading application has been approved by an administrator. */
  tradingApproved: boolean;
  /** Identity verification is approved — required before trading can be. */
  kycApproved: boolean;
  canSuspend: boolean;
  canToggleTrading: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply() {
    if (!pending) return;
    setError(null);
    setBusy(true);

    const body =
      pending.kind === 'suspend'
        ? { action: 'suspend', suspended: pending.suspended, reason }
        : pending.kind === 'approval'
          ? { action: 'approval', approved: pending.approved, reason }
          : { action: 'trading', disabled: pending.disabled, reason };

    try {
      const response = await fetch(`/api/users/${userId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? 'Could not apply the change.');
        return;
      }

      setPending(null);
      setReason('');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!canSuspend && !canToggleTrading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Controls</CardTitle>
        </CardHeader>
        <CardContent>
          <Notice tone="neutral">Your role can view this account but not change it.</Notice>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Controls</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {canSuspend ? (
            <Button
              variant={suspended ? 'secondary' : 'danger'}
              block
              onClick={() => {
                setPending({ kind: 'suspend', suspended: !suspended });
                setReason('');
                setError(null);
              }}
            >
              {suspended ? <RotateCcw className="size-3.5" /> : <Ban className="size-3.5" />}
              {suspended ? 'Reinstate account' : 'Suspend account'}
            </Button>
          ) : null}

          {canToggleTrading ? (
            <Button
              variant={tradingApproved ? 'secondary' : 'primary'}
              block
              disabled={!tradingApproved && !kycApproved}
              onClick={() => {
                setPending({ kind: 'approval', approved: !tradingApproved });
                setReason('');
                setError(null);
              }}
            >
              <ShieldCheck className="size-3.5" />
              {tradingApproved ? 'Revoke trading approval' : 'Approve trading'}
            </Button>
          ) : null}
          {canToggleTrading && !tradingApproved && !kycApproved ? (
            <p className="text-[11px] text-[var(--text-subtle)]">
              Trading can be approved once identity verification is approved.
            </p>
          ) : null}

          {canToggleTrading ? (
            <Button
              variant="secondary"
              block
              onClick={() => {
                setPending({ kind: 'trading', disabled: !tradingDisabled });
                setReason('');
                setError(null);
              }}
            >
              <CircleSlash className="size-3.5" />
              {tradingDisabled ? 'Enable trading' : 'Disable trading'}
            </Button>
          ) : null}

          <p className="pt-1 text-[11px] leading-relaxed text-[var(--text-subtle)]">
            Suspension is a compliance decision and revokes every active session. Trading approval
            is the separate application a customer makes to trade. Disabling trading is an
            operational stop that overrides an approval without removing it.
          </p>
        </CardContent>
      </Card>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{titleFor(pending)}</DialogTitle>
            <DialogDescription>{descriptionFor(pending)}</DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {error ? <Notice tone="negative">{error}</Notice> : null}

            <Field
              label="Reason"
              description="Recorded in the audit trail against your account. At least 8 characters."
              required
            >
              {(props) => (
                <Input
                  {...props}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  autoFocus
                />
              )}
            </Field>
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={isDestructive(pending) ? 'danger' : 'primary'}
              onClick={apply}
              loading={busy}
              disabled={reason.trim().length < 8}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function titleFor(action: Action | null): string {
  if (!action) return '';
  if (action.kind === 'suspend') {
    return action.suspended ? 'Suspend this account' : 'Reinstate this account';
  }
  if (action.kind === 'approval') {
    return action.approved ? 'Approve trading' : 'Revoke trading approval';
  }
  return action.disabled ? 'Disable trading' : 'Enable trading';
}

function descriptionFor(action: Action | null): string {
  if (!action) return '';

  if (action.kind === 'suspend') {
    return action.suspended
      ? 'The user will be signed out of every session and cannot sign in again until reinstated.'
      : 'The user will be able to sign in again. Trading is restored only if their verification is still approved.';
  }

  if (action.kind === 'approval') {
    return action.approved
      ? 'This approves the customer\'s trading application. They will be able to request quotes and place trades. Withdrawals are not affected either way.'
      : 'The customer will no longer be able to request quotes, place trades or start auto-trading. Their balance and withdrawals are not affected.';
  }

  return action.disabled
    ? 'The user keeps their account and can sign in, but cannot request quotes or place trades.'
    : 'The user will be able to trade again, subject to their verification status.';
}

function isDestructive(action: Action | null): boolean {
  if (!action) return false;
  if (action.kind === 'approval') return !action.approved;
  return action.kind === 'suspend' ? action.suspended : action.disabled;
}
