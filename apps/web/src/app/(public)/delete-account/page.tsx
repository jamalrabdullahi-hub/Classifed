import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@flt/ui';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('deleteAccount'))('publicTitle') };
}

/**
 * How to delete an FLT account — reachable without the app.
 *
 * Google Play requires a web page that explains account deletion for anybody
 * who has uninstalled the app or cannot sign in. The request itself is made
 * from the signed-in account page, because deleting an account holding custodied
 * money has to be tied to the person who owns it.
 */
export default async function DeleteAccountInfoPage() {
  const t = await getTranslations('deleteAccount');

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold text-[var(--text)]">{t('publicTitle')}</h1>
        <p className="mt-1.5 max-w-[64ch] text-[14px] leading-relaxed text-[var(--text-muted)]">{t('publicIntro')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('howTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="ml-1 list-decimal space-y-1.5 pl-4 text-[14px] leading-relaxed text-[var(--text-muted)]">
            <li>{t('how1')}</li>
            <li>{t('how2')}</li>
            <li>{t('how3')}</li>
            <li>{t('how4')}</li>
          </ol>
          <Button asChild variant="primary">
            <Link href="/akoon">{t('goToAccount')}</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('keptTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="max-w-[72ch] whitespace-pre-line text-[14px] leading-relaxed text-[var(--text-muted)]">
            {t('keptBody')}
          </p>
        </CardContent>
      </Card>

      <p className="text-[13px] text-[var(--text-subtle)]">{t('cannotSignIn')}</p>
    </div>
  );
}
