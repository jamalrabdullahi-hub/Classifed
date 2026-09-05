'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Copy, ShieldCheck } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DetailRow,
  Field,
  Input,
  Notice,
  StatusPill,
} from '@flt/ui';
import { ApiError, post } from '@/lib/api';

interface Enrollment {
  secret: string;
  uri: string;
}

/**
 * Multi-factor enrolment.
 *
 * Two steps by design: the secret is stored unconfirmed, and only becomes the
 * account's second factor once the user proves they can generate a valid code.
 * Activating on the first step would lock out anyone whose authenticator failed
 * to scan.
 *
 * Recovery codes are shown exactly once. Only their hashes are stored, so they
 * genuinely cannot be shown again — and the interface says so rather than
 * implying they can be retrieved later.
 */
export function AccountSecurity({
  mfaEnabled,
  recoveryCodesRemaining,
}: {
  mfaEnabled: boolean;
  recoveryCodesRemaining: number;
}) {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin() {
    setError(null);
    setBusy(true);
    try {
      setEnrollment(await post<Enrollment>('/api/account/mfa/enroll', {}));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not start enrolment.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setError(null);
    setBusy(true);
    try {
      const result = await post<{ recoveryCodes: string[] }>('/api/account/mfa/confirm', { code });
      setRecoveryCodes(result.recoveryCodes);
      setEnrollment(null);
      setCode('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCodes) {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Save your recovery codes</CardTitle>
            <CardDescription>
              Each code works once, if you lose access to your authenticator. They are stored only
              as hashes, so this is the only time they can be shown.
            </CardDescription>
          </div>
          <StatusPill tone="positive">MFA enabled</StatusPill>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4 sm:grid-cols-3">
            {recoveryCodes.map((value) => (
              <code key={value} className="num font-mono text-[13px] text-[var(--text)]">
                {value}
              </code>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void navigator.clipboard.writeText(recoveryCodes.join('\n'))}
            >
              <Copy className="size-3.5" />
              Copy all
            </Button>
            <Button variant="primary" size="sm" onClick={() => setRecoveryCodes(null)}>
              I have saved them
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>
            A second factor protects your account even if your password is stolen.
          </CardDescription>
        </div>
        {mfaEnabled ? (
          <StatusPill tone="positive">Enabled</StatusPill>
        ) : (
          <StatusPill tone="warning">Not enabled</StatusPill>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? <Notice tone="negative">{error}</Notice> : null}

        {mfaEnabled ? (
          <>
            <DetailRow
              label="Recovery codes remaining"
              value={
                <Badge tone={recoveryCodesRemaining <= 2 ? 'warning' : 'neutral'}>
                  {recoveryCodesRemaining}
                </Badge>
              }
              hint={
                recoveryCodesRemaining <= 2
                  ? 'Running low. Disable and re-enable MFA to generate a new set.'
                  : undefined
              }
            />
            <Notice tone="neutral" icon={<ShieldCheck className="size-4" />}>
              You will be asked for a code from your authenticator each time you sign in.
            </Notice>
          </>
        ) : enrollment ? (
          <>
            <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4">
              <p className="text-[13px] text-[var(--text-muted)]">
                Add this secret to your authenticator app, then enter the six-digit code it shows.
              </p>
              <code className="num block break-all font-mono text-[13px] text-[var(--text)]">
                {enrollment.secret}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void navigator.clipboard.writeText(enrollment.secret)}
              >
                <Copy className="size-3.5" />
                Copy secret
              </Button>
            </div>

            <Field label="Six-digit code">
              {(props) => (
                <Input
                  {...props}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  className="num text-center text-lg tracking-[0.3em]"
                  autoFocus
                />
              )}
            </Field>

            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setEnrollment(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={confirm}
                loading={busy}
                disabled={code.length !== 6}
              >
                Confirm and enable
              </Button>
            </div>
          </>
        ) : (
          <Button variant="primary" onClick={begin} loading={busy}>
            Enable two-factor authentication
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
