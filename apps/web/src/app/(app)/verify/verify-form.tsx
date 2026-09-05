'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Clock, ShieldCheck, XCircle } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Notice,
} from '@flt/ui';
import { ApiError, post } from '@/lib/api';

/**
 * Identity verification.
 *
 * The copy is deliberately plain about what happens next: a person reviews the
 * submission. Phase 1 does not run automated checks, and implying that it does
 * would misrepresent how the decision is made.
 */
export function VerifyForm({
  status,
  rejectionReason,
  submittedAt,
}: {
  status: string;
  rejectionReason: string | null;
  submittedAt: string | null;
}) {
  const router = useRouter();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      await post('/api/kyc', {
        legalFirstName: firstName,
        legalLastName: lastName,
        dateOfBirth,
        countryCode: countryCode.toUpperCase(),
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not submit. Try again.');
    } finally {
      setPending(false);
    }
  }

  if (status === 'APPROVED') {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="flex size-11 items-center justify-center rounded-full border border-[var(--positive-border)] bg-[var(--positive-subtle)]">
            <ShieldCheck className="size-5 text-[var(--positive)]" />
          </span>
          <div>
            <p className="text-sm font-semibold text-[var(--text)]">Identity verified</p>
            <p className="mt-1 text-[13px] text-[var(--text-muted)]">
              Your account is approved for trading.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status === 'IN_REVIEW' || status === 'PENDING') {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="flex size-11 items-center justify-center rounded-full border border-[var(--warning-border)] bg-[var(--warning-subtle)]">
            <Clock className="size-5 text-[var(--warning)]" />
          </span>
          <div className="max-w-sm">
            <p className="text-sm font-semibold text-[var(--text)]">Under review</p>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
              A member of our compliance team is reviewing your submission. You can connect a wallet
              and browse markets while you wait.
            </p>
            {submittedAt ? (
              <p className="mt-2 text-[11px] text-[var(--text-subtle)]">
                Submitted {new Date(submittedAt).toLocaleString()}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Verify your identity</CardTitle>
          <CardDescription>
            Required before trading. A member of our compliance team reviews each submission — this
            is not an automated check, so it may take a little time.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent>
        {status === 'REJECTED' ? (
          <Notice tone="negative" icon={<XCircle className="size-4" />} className="mb-4">
            {rejectionReason ?? 'Your previous submission was not approved. You may submit again.'}
          </Notice>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-4">
          {error ? <Notice tone="negative">{error}</Notice> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Legal first name" required>
              {(props) => (
                <Input
                  {...props}
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  autoComplete="given-name"
                  required
                />
              )}
            </Field>

            <Field label="Legal last name" required>
              {(props) => (
                <Input
                  {...props}
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  autoComplete="family-name"
                  required
                />
              )}
            </Field>
          </div>

          <Field label="Date of birth" description="You must be at least 18." required>
            {(props) => (
              <Input
                {...props}
                type="date"
                value={dateOfBirth}
                onChange={(event) => setDateOfBirth(event.target.value)}
                autoComplete="bday"
                required
              />
            )}
          </Field>

          <Field
            label="Country of residence"
            description="Two-letter country code, for example US or GB."
            required
          >
            {(props) => (
              <Input
                {...props}
                value={countryCode}
                onChange={(event) => setCountryCode(event.target.value.toUpperCase().slice(0, 2))}
                maxLength={2}
                autoComplete="country"
                className="uppercase"
                required
              />
            )}
          </Field>

          <Button type="submit" variant="primary" block loading={pending}>
            Submit for review
          </Button>

          <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">
            These details are used only to verify your identity for regulatory purposes. FLT never
            asks for a seed phrase, private key or wallet password as part of verification, and
            nobody legitimate ever will.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
