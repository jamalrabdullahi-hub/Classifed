import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Info } from 'lucide-react';
import { ThemeToggle } from '@/components/theme';
import { LanguageSwitcher } from '@/components/language-switcher';
import { LearnLessons, lessonTitles } from '@/components/learn/lessons';
import { HeroEmblem } from './infographics';

const CANONICAL = 'https://learn.ftlexchange.com/';

/**
 * The optional free account, which saves lessons on the signed-in lessons page.
 * It is not a trading account: trading is a separate application.
 */
const ACCOUNT_URL = 'https://ftlexchange.com/signup?next=/educate/home';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('learn.meta');
  return {
    title: { absolute: t('title') },
    description: t('description'),
    applicationName: 'FTL Learn',
    robots: { index: true, follow: true },
    alternates: { canonical: CANONICAL },
    openGraph: { type: 'article', title: t('title'), description: t('description'), url: CANONICAL, siteName: 'FTL Learn' },
    twitter: { card: 'summary', title: t('title'), description: t('description') },
  };
}

/**
 * FTL Learn — learn.ftlexchange.com, the public landing.
 *
 * Lessons only, and no exchange advertising of any kind. The static notice at
 * the top says what a reviewer needs to know without asking: this is FTL Learn,
 * trading is a different product, a Learn account cannot trade, and enabling
 * trading is a separate application. The one link off the page is the optional
 * free account.
 */
export default async function LearnPage() {
  const t = await getTranslations('learn');
  const toc = await lessonTitles();

  return (
    <div className="flex min-h-screen flex-col bg-[var(--canvas)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--canvas)]/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text)]">FTL Learn</span>
          <nav aria-label={t('tocLabel')} className="hidden items-center gap-5 text-[13px] md:flex">
            {toc.map(({ id, title }) => (
              <a key={id} href={`#${id}`} className="text-[var(--text-muted)] hover:text-[var(--text)]">
                {title}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <LanguageSwitcher className="hidden sm:inline-flex" />
            <ThemeToggle />
            <a href={ACCOUNT_URL} className="text-[13px] text-[var(--text-muted)] hover:text-[var(--text)]">
              {t('account.label')}
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-12 px-4 py-12 sm:px-6">
        <section className="grid items-center gap-10 md:grid-cols-[1fr_auto]">
          <div className="max-w-2xl">
            <p className="text-[12px] font-medium uppercase tracking-[0.12em] text-[var(--accent-text)]">{t('hero.eyebrow')}</p>
            <h1 className="mt-3 text-[32px] font-semibold leading-[1.1] tracking-[-0.02em] text-[var(--text)] [text-wrap:balance] sm:text-[44px]">
              {t('hero.title')}
            </h1>
            <p className="mt-4 max-w-[60ch] text-[15px] leading-relaxed text-[var(--text-muted)]">{t('hero.intro')}</p>
          </div>
          <div className="hidden justify-center md:flex">
            <HeroEmblem />
          </div>
        </section>

        <aside role="note" className="flex gap-3 rounded-[var(--radius-lg)] border border-[var(--info-border)] bg-[var(--info-subtle)] p-4">
          <Info className="mt-0.5 size-4 shrink-0 text-[var(--info)]" aria-hidden="true" />
          <div>
            <p className="text-[13.5px] font-semibold text-[var(--text)]">{t('separate.title')}</p>
            <ul className="mt-1.5 space-y-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
              {(t.raw('separate.points') as string[]).map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </aside>

        <LearnLessons />

        <section className="flex flex-col items-start gap-3 border-t border-[var(--border)] pt-10 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl">
            <h2 className="text-[17px] font-semibold text-[var(--text)]">{t('account.title')}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">{t('account.body')}</p>
          </div>
          <a
            href={ACCOUNT_URL}
            className="rounded-[var(--radius-md)] border border-[var(--border-strong)] px-4 py-2 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--surface-hover)]"
          >
            {t('account.label')}
          </a>
        </section>
      </main>

      <footer className="border-t border-[var(--border)] py-8">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <p className="max-w-[80ch] text-[12px] leading-relaxed text-[var(--text-subtle)]">{t('footer')}</p>
        </div>
      </footer>
    </div>
  );
}
