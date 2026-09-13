import type { Metadata } from 'next';
import { env } from '@flt/config';
import { assetLinksFor } from '@flt/core/domain/asset-links';
import { resolveAndroidAppSettings } from '@flt/core/services/platform-settings';
import { Card, CardContent, CardHeader, CardTitle, Notice, StatusPill } from '@flt/ui';
import { AndroidSettingsForm } from './android-settings-form';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Mobile app' };
export const dynamic = 'force-dynamic';

/**
 * The Android app, from the operator's side.
 *
 * Two things can be wrong without anything crashing, so both are shown here
 * rather than discovered by a user: the asset-links file (without a matching
 * fingerprint the app opens with a URL bar) and the download details.
 */
export default async function MobileAppPage() {
  await requireAdminPage();

  const settings = await resolveAndroidAppSettings();
  const { ANDROID_PACKAGE_NAME, ANDROID_CERT_SHA256 } = env();
  const links = assetLinksFor(ANDROID_PACKAGE_NAME, ANDROID_CERT_SHA256);
  const fingerprints = links[0]?.target.sha256_cert_fingerprints ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[18px] font-semibold text-[var(--text)]">Mobile app</h1>
        <p className="mt-1 max-w-[72ch] text-[13px] leading-relaxed text-[var(--text-muted)]">
          The Android app opens ftlexchange.com full-screen, so every web deploy updates it. Build and
          signing steps are in <code>apps/android/README.md</code>.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Full-screen verification (asset links)</CardTitle>
          <StatusPill tone={fingerprints.length >= 2 ? 'positive' : fingerprints.length === 1 ? 'warning' : 'negative'}>
            {fingerprints.length >= 2 ? 'Both certificates' : fingerprints.length === 1 ? 'One certificate' : 'Not set'}
          </StatusPill>
        </CardHeader>
        <CardContent className="space-y-2 text-[13px]">
          <p className="text-[var(--text-muted)]">
            Package <code>{ANDROID_PACKAGE_NAME}</code> · served at{' '}
            <code>/.well-known/assetlinks.json</code>
          </p>
          {fingerprints.length === 0 ? (
            <Notice tone="negative">
              No valid fingerprint in <code>ANDROID_CERT_SHA256</code>. The app will open with a URL bar
              until it is set on the server.
            </Notice>
          ) : fingerprints.length === 1 ? (
            <Notice tone="warning">
              Only one certificate is listed. Play installs need the Play app-signing certificate and the
              direct APK needs the upload key: one of the two install routes will show a URL bar.
            </Notice>
          ) : null}
          {fingerprints.map((value) => (
            <p key={value} className="num break-all font-mono text-[11px] text-[var(--text)]">
              {value}
            </p>
          ))}
        </CardContent>
      </Card>

      <AndroidSettingsForm initial={settings} />
    </div>
  );
}
