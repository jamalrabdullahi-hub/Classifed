'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Lock } from 'lucide-react';
import { Button, Card, CardContent, Field, Input, Notice } from '@flt/ui';

/**
 * Administrator sign-in.
 *
 * Deliberately plain. There is no registration link, no password reset and no
 * account recovery: administrators are provisioned by another administrator,
 * and a self-service recovery flow on an operator panel is an attack surface
 * with no legitimate user.
 */
export function AdminLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password }),
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? 'Could not sign in.');
        return;
      }

      router.replace('/');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 flex size-10 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
            <Lock className="size-4 text-[var(--text-muted)]" />
          </span>
          <h1 className="text-lg font-semibold tracking-[-0.02em] text-[var(--text)]">
            FLT Administration
          </h1>
          <p className="mt-1 text-[13px] text-[var(--text-muted)]">
            Authorised personnel only. All activity is logged.
          </p>
        </div>

        <Card>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              {error ? <Notice tone="negative">{error}</Notice> : null}

              <Field label="Email">
                {(props) => (
                  <Input
                    {...props}
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="username"
                    required
                    autoFocus
                  />
                )}
              </Field>

              <Field label="Password">
                {(props) => (
                  <Input
                    {...props}
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                )}
              </Field>

              <Button type="submit" variant="primary" block loading={pending}>
                Sign in
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-[var(--text-subtle)]">
          Administrator accounts are provisioned by another administrator. There is no self-service
          recovery.
        </p>
      </div>
    </div>
  );
}
