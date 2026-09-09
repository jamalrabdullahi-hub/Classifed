'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Check, KeyRound } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Notice, StatusPill } from '@flt/ui';

interface Settings {
  enabled: boolean;
  deepSeekKeyConfigured: boolean;
  encryptionKeyConfigured: boolean;
}

/**
 * Toggle + key entry for agentic trading.
 *
 * The DeepSeek key field is write-only by design: GET never returns the
 * actual key, only whether one is configured, so this screen never displays
 * a live secret back to whoever opens it later.
 */
export function AgentSettingsClient() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'toggle' | 'key' | null>(null);

  async function load() {
    const response = await fetch('/api/agent-settings', { credentials: 'same-origin' });
    const payload = await response.json();
    if (response.ok) setSettings(payload.data);
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(enabled: boolean) {
    setError(null);
    setBusy('toggle');
    try {
      const response = await fetch('/api/agent-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'toggle', enabled }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? 'Could not change this.');
        return;
      }
      await load();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  async function saveKey() {
    setError(null);
    setBusy('key');
    try {
      const response = await fetch('/api/agent-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'set-key', apiKey }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? 'Could not save this key.');
        return;
      }
      setApiKey('');
      await load();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  if (!settings) return null;

  const canEnable = settings.encryptionKeyConfigured && settings.deepSeekKeyConfigured;

  return (
    <div className="space-y-5">
      {error ? <Notice tone="negative">{error}</Notice> : null}

      {!settings.encryptionKeyConfigured ? (
        <Notice tone="warning" icon={<AlertTriangle className="size-4" />} title="Server not ready">
          AGENT_KEY_ENCRYPTION_KEY is not set on this server. That one stays server-side by design
          — it encrypts every participant's venue signing key, so it cannot live in the same
          database it protects. Set it in the server's environment and restart before this can be
          enabled here.
        </Notice>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>DeepSeek API key</CardTitle>
          {settings.deepSeekKeyConfigured ? (
            <StatusPill tone="positive">
              <Check className="size-3" /> Configured
            </StatusPill>
          ) : (
            <StatusPill tone="neutral">Not set</StatusPill>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[12px] leading-relaxed text-[var(--text-subtle)]">
            Write-only: once saved, this screen never displays the key again, only whether one is
            configured.
          </p>
          <Field label="API key">
            {(props) => (
              <Input
                {...props}
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-…"
                autoComplete="off"
              />
            )}
          </Field>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void saveKey()}
            loading={busy === 'key'}
            disabled={apiKey.trim().length < 10}
          >
            <KeyRound className="size-3.5" />
            Save key
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Platform switch</CardTitle>
          <StatusPill tone={settings.enabled ? 'positive' : 'neutral'}>
            {settings.enabled ? 'Live' : 'Off'}
          </StatusPill>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[12px] leading-relaxed text-[var(--text-subtle)]">
            Turning this on lets any eligible account configure and run the AI trading agent —
            real, signed trades on their allocated venues the moment their own agent is active.
          </p>

          {/*
            Name the one thing still missing, rather than restating both
            requirements. A disabled button beside "both of these must be set"
            reads as broken to somebody who has just set one of them and is
            looking at it marked Configured.
          */}
          {!canEnable ? (
            <Notice tone="warning" title="Cannot be turned on yet">
              {!settings.encryptionKeyConfigured && !settings.deepSeekKeyConfigured
                ? 'AGENT_KEY_ENCRYPTION_KEY is missing from the server environment, and no DeepSeek key is saved.'
                : !settings.encryptionKeyConfigured
                  ? 'The DeepSeek key is saved. The only thing still missing is AGENT_KEY_ENCRYPTION_KEY in the server environment — generate it on the server, add it to the .env there, and restart. It cannot be set from this panel.'
                  : 'The server key is in place. Save a DeepSeek API key above and this will turn on.'}
            </Notice>
          ) : null}
          <Button
            variant={settings.enabled ? 'danger' : 'primary'}
            size="sm"
            onClick={() => void toggle(!settings.enabled)}
            loading={busy === 'toggle'}
            disabled={!canEnable && !settings.enabled}
          >
            {settings.enabled ? 'Turn off' : 'Turn on'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
