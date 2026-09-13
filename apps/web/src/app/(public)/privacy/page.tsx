import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { env } from '@flt/config';
import { Notice } from '@flt/ui';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('legal'))('privacy.title') };
}

/**
 * Privacy policy.
 *
 * Written from what the code actually does — which data is collected, which
 * processors receive it, how long identity documents are kept — so it is at
 * least true. It is still a **draft**: which laws apply, and what rights they
 * give, is a question for a lawyer, and the page says so rather than presenting
 * itself as final.
 */
const SECTIONS = ['collect', 'use', 'processors', 'retention', 'rights', 'contact'] as const;

export default async function PrivacyPage() {
  const t = await getTranslations('legal');
  const retentionYears = Math.round(env().KYC_DOCUMENT_RETENTION_DAYS / 365);

  return (
    <article className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold text-[var(--text)]">{t('privacy.title')}</h1>
        <p className="mt-1 text-[12px] text-[var(--text-subtle)]">{t('updated')}</p>
      </div>

      <Notice tone="warning">{t('draftNotice')}</Notice>

      <p className="max-w-[72ch] text-[14px] leading-relaxed text-[var(--text-muted)]">{t('privacy.intro')}</p>

      {SECTIONS.map((key) => (
        <section key={key} className="space-y-1.5">
          <h2 className="text-[15px] font-semibold text-[var(--text)]">{t(`privacy.${key}Title`)}</h2>
          <p className="max-w-[72ch] whitespace-pre-line text-[14px] leading-relaxed text-[var(--text-muted)]">
            {t(`privacy.${key}Body`, { years: retentionYears })}
          </p>
        </section>
      ))}
    </article>
  );
}
