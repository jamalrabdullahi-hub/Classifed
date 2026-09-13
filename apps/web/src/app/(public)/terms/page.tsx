import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Notice } from '@flt/ui';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('legal'))('terms.title') };
}

/**
 * Terms of use.
 *
 * A **draft**, marked as one. It describes the product as it works — custody,
 * leverage and liquidation, fees, suspension — so nothing in it is aspirational,
 * but the binding wording and governing law are for a lawyer to settle.
 */
const SECTIONS = ['eligibility', 'custody', 'risk', 'fees', 'prohibited', 'termination', 'liability', 'contact'] as const;

export default async function TermsPage() {
  const t = await getTranslations('legal');

  return (
    <article className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold text-[var(--text)]">{t('terms.title')}</h1>
        <p className="mt-1 text-[12px] text-[var(--text-subtle)]">{t('updated')}</p>
      </div>

      <Notice tone="warning">{t('draftNotice')}</Notice>

      <p className="max-w-[72ch] text-[14px] leading-relaxed text-[var(--text-muted)]">{t('terms.intro')}</p>

      {SECTIONS.map((key) => (
        <section key={key} className="space-y-1.5">
          <h2 className="text-[15px] font-semibold text-[var(--text)]">{t(`terms.${key}Title`)}</h2>
          <p className="max-w-[72ch] whitespace-pre-line text-[14px] leading-relaxed text-[var(--text-muted)]">
            {t(`terms.${key}Body`)}
          </p>
        </section>
      ))}
    </article>
  );
}
