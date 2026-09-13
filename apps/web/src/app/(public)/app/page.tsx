import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Download, ShieldCheck } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Notice } from '@flt/ui';
import { resolveAndroidAppSettings } from '@flt/core/services/platform-settings';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('androidApp'))('title') };
}
export const dynamic = 'force-dynamic';

/**
 * Getting the Android app.
 *
 * Public, because the people who need this page most have not signed up yet.
 * The checksum sits beside the download on purpose: sideloading means trusting
 * a file, and the checksum is how somebody checks it is the file FLT released
 * rather than a copy from a forwarded link.
 */
export default async function AndroidAppPage() {
  const t = await getTranslations('androidApp');
  const settings = await resolveAndroidAppSettings();
  const hasPlay = Boolean(settings.playUrl);
  const hasApk = Boolean(settings.apkUrl);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold text-[var(--text)]">{t('title')}</h1>
        <p className="mt-1.5 max-w-[60ch] text-[14px] leading-relaxed text-[var(--text-muted)]">{t('intro')}</p>
      </div>

      {!hasPlay && !hasApk ? <Notice tone="info">{t('comingSoon')}</Notice> : null}

      {hasPlay ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('playTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[13px] text-[var(--text-muted)]">{t('playBody')}</p>
            <Button asChild variant="primary" size="lg">
              <a href={settings.playUrl} rel="noopener noreferrer">
                {t('playCta')}
              </a>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {hasApk ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('apkTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-[13px] text-[var(--text-muted)]">{t('apkBody')}</p>

            <Button asChild variant={hasPlay ? 'secondary' : 'primary'} size="lg">
              <a href={settings.apkUrl} download>
                <Download className="size-4" />
                {settings.apkVersion ? t('apkCtaVersion', { version: settings.apkVersion }) : t('apkCta')}
              </a>
            </Button>

            <ol className="ml-1 list-decimal space-y-1.5 pl-4 text-[13px] leading-relaxed text-[var(--text-muted)]">
              <li>{t('step1')}</li>
              <li>{t('step2')}</li>
              <li>{t('step3')}</li>
            </ol>

            {settings.apkSha256 ? (
              <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
                <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                  <ShieldCheck className="size-3.5" />
                  {t('checksumLabel')}
                </p>
                <p className="num mt-1 select-all break-all font-mono text-[12px] text-[var(--text)]">
                  {settings.apkSha256}
                </p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--text-subtle)]">{t('checksumNote')}</p>
              </div>
            ) : null}

            <Notice tone="warning">{t('onlyHere')}</Notice>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
