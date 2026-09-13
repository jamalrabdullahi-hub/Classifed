'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Notice } from '@flt/ui';

interface AndroidSettings {
  playUrl: string;
  apkUrl: string;
  apkVersion: string;
  apkSha256: string;
}

/**
 * The download details shown on the public /app page.
 *
 * The checksum is required whenever an APK link is set. People who sideload
 * install whatever file the link serves, and the published checksum is the only
 * way they can tell it is the one FLT built.
 */
export function AndroidSettingsForm({ initial }: { initial: AndroidSettings }) {
  const router = useRouter();
  const [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = (patch: Partial<AndroidSettings>) => setDraft((current) => ({ ...current, ...patch }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      const response = await fetch('/api/android-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(draft),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Could not save this');
      setSaved(true);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save this');
    } finally {
      setPending(false);
    }
  }

  const field = (label: string, key: keyof AndroidSettings, description: string, placeholder: string) => (
    <Field label={label} description={description}>
      {(props) => (
        <Input
          {...props}
          value={draft[key]}
          placeholder={placeholder}
          onChange={(event) => set({ [key]: event.target.value } as Partial<AndroidSettings>)}
          className={key === 'apkSha256' ? 'num font-mono' : undefined}
        />
      )}
    </Field>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Download page</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {error ? <Notice tone="negative">{error}</Notice> : null}
          {saved ? <Notice tone="positive">Saved. The /app page shows this now.</Notice> : null}

          {field(
            'Play Store link',
            'playUrl',
            'Leave empty until the app is approved on Play.',
            'https://play.google.com/store/apps/details?id=com.ftlexchange.app',
          )}
          {field(
            'APK link',
            'apkUrl',
            'The file you copied to /var/www/flt-downloads/.',
            'https://ftlexchange.com/downloads/flt-1.0.0.apk',
          )}
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            {field('Version', 'apkVersion', 'As shown to people.', '1.0.0')}
            {field('SHA-256 checksum', 'apkSha256', 'From `sha256sum` on the server.', '64 hex characters')}
          </div>

          <Button type="submit" variant="primary" loading={pending}>
            Save download details
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
