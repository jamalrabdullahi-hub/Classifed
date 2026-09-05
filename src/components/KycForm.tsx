'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiRequestError, api } from './api';

export function KycForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    fullName: '',
    dateOfBirth: '',
    nationality: 'SO',
    addressLine: '',
    city: '',
    country: 'SO',
    documentType: 'NATIONAL_ID',
    documentNumber: '',
  });

  function set(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post('/api/kyc', form);
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Verification could not be submitted');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h1>Verify your identity</h1>
      <p className="muted">Required before you can trade or withdraw.</p>
      {error ? <p className="error">{error}</p> : null}

      <label>
        <span>Full legal name</span>
        <input value={form.fullName} required onChange={set('fullName')} />
      </label>

      <label>
        <span>Date of birth</span>
        <input type="date" value={form.dateOfBirth} required onChange={set('dateOfBirth')} />
      </label>

      <label>
        <span>Nationality</span>
        <input value={form.nationality} required onChange={set('nationality')} />
      </label>

      <label>
        <span>Address</span>
        <input value={form.addressLine} required onChange={set('addressLine')} />
      </label>

      <label>
        <span>City</span>
        <input value={form.city} required onChange={set('city')} />
      </label>

      <label>
        <span>Country</span>
        <input value={form.country} required onChange={set('country')} />
      </label>

      <label>
        <span>Document type</span>
        <select value={form.documentType} onChange={set('documentType')}>
          <option value="NATIONAL_ID">National ID</option>
          <option value="PASSPORT">Passport</option>
          <option value="DRIVING_LICENCE">Driving licence</option>
        </select>
      </label>

      <label>
        <span>Document number</span>
        <input value={form.documentNumber} required onChange={set('documentNumber')} />
      </label>

      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Submitting…' : 'Submit for verification'}
      </button>
    </form>
  );
}
