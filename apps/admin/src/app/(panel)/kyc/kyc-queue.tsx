'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, X } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  Field,
  Input,
  Notice,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@flt/ui';

export interface QueuedProfile {
  id: string;
  userId: string;
  email: string;
  legalName: string;
  countryCode: string | null;
  dateOfBirth: string | null;
  submittedAt: string | null;
  accountCreatedAt: string;
}

/**
 * KYC decisions.
 *
 * Both approve and reject go through a confirmation dialog that requires a
 * reason. Approving is as consequential as rejecting — it is what lets someone
 * trade — so it is not a one-click action either.
 */
export function KycQueue({
  profiles,
  canDecide,
}: {
  profiles: QueuedProfile[];
  canDecide: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<{ profile: QueuedProfile; approve: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide() {
    if (!pending) return;
    setError(null);
    setBusy(true);

    try {
      const response = await fetch(`/api/kyc/${pending.profile.userId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ approve: pending.approve, reason }),
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? 'Could not record the decision.');
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

  return (
    <>
      {!canDecide ? (
        <Notice tone="neutral" className="mb-4">
          Your role can view this queue but not decide on submissions.
        </Notice>
      ) : null}

      <div className="space-y-3">
        {profiles.map((profile) => (
          <Card key={profile.id}>
            <CardContent className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <p className="text-[14px] font-medium text-[var(--text)]">{profile.legalName}</p>
                <p className="text-[12px] text-[var(--text-muted)]">{profile.email}</p>
                <p className="num text-[11px] text-[var(--text-subtle)]">
                  {profile.countryCode ?? '—'}
                  {profile.dateOfBirth
                    ? ` · born ${new Date(profile.dateOfBirth).toLocaleDateString()}`
                    : ''}
                  {profile.submittedAt
                    ? ` · submitted ${new Date(profile.submittedAt).toLocaleString()}`
                    : ''}
                </p>
              </div>

              {canDecide ? (
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setPending({ profile, approve: false });
                      setReason('');
                      setError(null);
                    }}
                  >
                    <X className="size-3.5" />
                    Reject
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setPending({ profile, approve: true });
                      setReason('');
                      setError(null);
                    }}
                  >
                    <Check className="size-3.5" />
                    Approve
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pending?.approve ? 'Approve verification' : 'Reject verification'}
            </DialogTitle>
            <DialogDescription>
              {pending?.approve
                ? `${pending?.profile.legalName} will be able to trade. This decision is recorded against your account.`
                : `${pending?.profile.legalName} will not be able to trade, and will see the reason you give.`}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {error ? <Notice tone="negative">{error}</Notice> : null}

            <Field
              label="Reason"
              description="Recorded in the audit trail. At least 8 characters."
              required
            >
              {(props) => (
                <Input
                  {...props}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={
                    pending?.approve ? 'Documents verified against register' : 'Details did not match'
                  }
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
              variant={pending?.approve ? 'primary' : 'danger'}
              onClick={decide}
              loading={busy}
              disabled={reason.trim().length < 8}
            >
              {pending?.approve ? 'Approve' : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
