'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiRequestError, api } from './api';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post(isRegister ? '/api/auth/register' : '/api/auth/login', {
        email,
        password,
        ...(isRegister && phone ? { phone } : {}),
      });
      router.push(isRegister ? '/kyc' : '/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h1>{isRegister ? 'Create an account' : 'Sign in'}</h1>
      {error ? <p className="error">{error}</p> : null}

      <label>
        <span>Email</span>
        <input
          type="email"
          value={email}
          required
          autoComplete="email"
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>

      <label>
        <span>Password{isRegister ? ' (at least 10 characters)' : ''}</span>
        <input
          type="password"
          value={password}
          required
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>

      {isRegister ? (
        <label>
          <span>Mobile number (optional)</span>
          <input
            type="tel"
            value={phone}
            placeholder="+252612345678"
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
      ) : null}

      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
      </button>

      <p className="muted" style={{ marginTop: 16 }}>
        {isRegister ? (
          <>Already have an account? <a href="/login">Sign in</a></>
        ) : (
          <>New here? <a href="/register">Create an account</a></>
        )}
      </p>
    </form>
  );
}
