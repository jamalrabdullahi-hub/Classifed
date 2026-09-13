'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Notice } from '@flt/ui';

/**
 * Editing the AI credentials.
 *
 * The key field is write-only: blank means "keep the existing key", a value
 * means "replace it". It is never rendered back — an operator can see that a
 * key is set, never what it is.
 */
export function AiSettingsForm({
  enabled,
  apiUrl,
  model,
  keySet,
  canEdit,
}: {
  enabled: boolean;
  apiUrl: string;
  model: string;
  keySet: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState({ enabled, apiUrl, model });
  const [apiKey, setApiKey] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      const response = await fetch('/api/ai-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: draft.enabled,
          apiUrl: draft.apiUrl.trim(),
          model: draft.model.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          reason: reason.trim().length >= 8 ? reason.trim() : 'Updated AI settings from the admin panel',
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(payload.error?.message ?? 'Could not save');
      setSaved(true);
      setApiKey('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={save}
      className="max-w-xl space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] p-4"
    >
      {error ? <Notice tone="negative">{error}</Notice> : null}
      {saved ? <Notice tone="positive">Saved.</Notice> : null}

      <label className="flex items-center gap-2 text-[13px] text-[var(--text)]">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={!canEdit}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
        AI trading enabled
      </label>

      <Field label="API URL">
        {(props) => (
          <Input
            {...props}
            value={draft.apiUrl}
            disabled={!canEdit}
            placeholder="https://api.deepseek.com/v1"
            onChange={(event) => setDraft({ ...draft, apiUrl: event.target.value })}
          />
        )}
      </Field>

      <Field label="Model">
        {(props) => (
          <Input
            {...props}
            value={draft.model}
            disabled={!canEdit}
            placeholder="deepseek-chat"
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          />
        )}
      </Field>

      <Field
        label="API key"
        description={
          keySet
            ? 'A key is set. Leave blank to keep it; paste a new one to replace it.'
            : 'Paste your provider key (e.g. an sk-... DeepSeek key).'
        }
      >
        {(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="off"
            value={apiKey}
            disabled={!canEdit}
            placeholder={keySet ? '••••••••••••' : 'sk-...'}
            onChange={(event) => setApiKey(event.target.value)}
          />
        )}
      </Field>

      <Field label="Reason" description="Recorded in the audit trail.">
        {(props) => (
          <Input
            {...props}
            value={reason}
            disabled={!canEdit}
            placeholder="Enabling AI trading with a DeepSeek key"
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>

      {canEdit ? (
        <Button type="submit" loading={pending}>
          Save
        </Button>
      ) : null}
    </form>
  );
}
