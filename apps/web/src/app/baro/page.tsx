import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
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

/** The exchange funnel: its own sign-up, labelled as a different product. */
const EXCHANGE_URL = 'https://ftlexchange.com/signup';

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
 * Lessons first. The static notice at the top says what a reviewer needs to
 * know without asking: this is FTL Learn, trading is a different product, a
 * Learn account cannot trade, and enabling trading is a separate application.
 *
 * One labelled advertisement for FTL Exchange runs above the header, and a
 * second, different creative is pinned to the bottom of the screen and stays
 * while the lessons scroll. Both say it is a separate product whose trading needs its
 * own application, review and approval. The optional free Learn account sits
 * at the foot of the page.
 *
 * The header holds only the brand, language, theme and that account link: the
 * lesson titles are long in Somali and belong in the lesson index below, not
 * squeezed into a bar.
 */
export default async function LearnPage() {
  const t = await getTranslations('learn');
  const locale = await getLocale();
  const lessons = await lessonTitles();
  // The ad creative, in the reader's language.
  const lang = locale === 'en' ? 'en' : 'so';
  // Compact horizontal creative: the full 1200x628 banner filled the whole
  // first screen, which buried the lessons.
  const banner = `/ads/ftl-exchange-compact-${lang}.jpg`;
  // A different creative for the pinned strip: wide, short, its own wording.
  const strip = `/ads/ftl-exchange-strip-${lang}.jpg`;

  return (
    <div className="flex min-h-screen flex-col bg-[var(--canvas)]">
      <section aria-labelledby="exchange-cta" className="mx-auto w-full max-w-6xl space-y-2 px-4 pt-3 sm:px-6">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">
          {t('exchange.label')}
        </p>
        <a
          href={EXCHANGE_URL}
          className="block overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]"
        >
          {/* The creative carries its own risk line, so it stands alone if reposted.
              Below 640px it is replaced by text: a 5:1 image would be unreadable. */}
          <img
            src={banner}
            alt={`${t('exchange.title')} ${t('exchange.cta')}`}
            width={1400}
            height={260}
            className="hidden h-auto w-full sm:block"
          />
          <span className="flex items-center justify-between gap-3 bg-[var(--surface)] px-3.5 py-3 sm:hidden">
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold text-[var(--text)]">{t('exchange.title')}</span>
              <span className="block text-[11.5px] leading-snug text-[var(--text-subtle)]">{t('exchange.note')}</span>
            </span>
            <span className="shrink-0 whitespace-nowrap rounded-[var(--radius-md)] bg-[var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-[var(--text-inverse)]">
              {t('exchange.cta')}
            </span>
          </span>
        </a>
        <h2 id="exchange-cta" className="sr-only">
          {t('exchange.title')}
        </h2>
        {/* On a phone the same point is made by the notice below, and this
            paragraph would double the ad's height. */}
        <p className="hidden max-w-[80ch] text-[11.5px] leading-relaxed text-[var(--text-subtle)] sm:block">
          {t('exchange.body')}
        </p>
      </section>

      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--canvas)]/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <span className="whitespace-nowrap text-[15px] font-semibold tracking-[-0.01em] text-[var(--text)]">
            FTL Learn
          </span>
          <div className="flex items-center gap-2.5 sm:gap-3">
            <LanguageSwitcher className="hidden sm:inline-flex" />
            <ThemeToggle />
            <a
              href={ACCOUNT_URL}
              className="whitespace-nowrap rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--text)] hover:bg-[var(--surface-hover)]"
            >
              {t('account.headerLabel')}
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-10 px-4 py-10 sm:px-6 sm:py-14">
        <section className="grid items-center gap-10 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="max-w-2xl">
            <p className="text-[12px] font-medium uppercase tracking-[0.12em] text-[var(--accent-text)]">{t('hero.eyebrow')}</p>
            <h1 className="mt-3 text-[30px] font-semibold leading-[1.1] tracking-[-0.02em] text-[var(--text)] [text-wrap:balance] sm:text-[42px]">
              {t('hero.title')}
            </h1>
            <p className="mt-4 max-w-[60ch] text-[15px] leading-relaxed text-[var(--text-muted)]">{t('hero.intro')}</p>
          </div>
          <div className="hidden justify-center md:flex">
            <HeroEmblem />
          </div>
        </section>

        <aside role="note" className="flex gap-3 rounded-[var(--radius-lg)] border border-[var(--info-border)] bg-[var(--info-subtle)] p-4 sm:p-5">
          <Info className="mt-0.5 size-4 shrink-0 text-[var(--info)]" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[13.5px] font-semibold text-[var(--text)]">{t('separate.title')}</p>
            <ul className="mt-1.5 space-y-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
              {(t.raw('separate.points') as string[]).map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </aside>

        <nav aria-label={t('tocLabel')}>
          <p className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.1em] text-[var(--text-subtle)]">{t('tocLabel')}</p>
          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {lessons.map(({ id, title }, index) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="flex h-full items-start gap-2.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-3.5 transition-colors hover:border-[var(--border-strong)]"
                >
                  <span className="num text-[12px] font-semibold text-[var(--accent-text)]">{index + 1}</span>
                  <span className="text-[13px] font-medium leading-snug text-[var(--text)]">{title}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="space-y-12">
          <LearnLessons />
        </div>

        <section className="flex flex-col items-start gap-3 border-t border-[var(--border)] pt-10 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl">
            <h2 className="text-[17px] font-semibold text-[var(--text)]">{t('account.title')}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">{t('account.body')}</p>
          </div>
          <a
            href={ACCOUNT_URL}
            className="whitespace-nowrap rounded-[var(--radius-md)] border border-[var(--border-strong)] px-4 py-2 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--surface-hover)]"
          >
            {t('account.label')}
          </a>
        </section>
      </main>


      {/* Stays visible while the lessons scroll. Labelled, and never covers
          the page: main reserves room for it below. */}
      <aside
        aria-label={t('exchange.label')}
        className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--border)] bg-[var(--canvas)]/95 backdrop-blur"
      >
        <a href={EXCHANGE_URL} className="mx-auto block max-w-6xl px-4 py-2 sm:px-6">
          {/* Its own creative, wider than it is tall. On a phone the same ad is
              set as text, because cropping a 8:1 image loses the offer. */}
          <img
            src={strip}
            alt={`${t('exchange.title')} ${t('exchange.cta')}`}
            width={1600}
            height={200}
            className="hidden h-auto w-full rounded-[var(--radius-sm)] sm:block"
          />
          <span className="flex items-center justify-between gap-3 sm:hidden">
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">
                {t('exchange.label')}
              </span>
              <span className="block truncate text-[12.5px] text-[var(--text-muted)]">{t('exchange.title')}</span>
            </span>
            <span className="shrink-0 whitespace-nowrap rounded-[var(--radius-md)] bg-[var(--accent)] px-3.5 py-2 text-[12.5px] font-semibold text-[var(--text-inverse)]">
              {t('exchange.cta')}
            </span>
          </span>
        </a>
      </aside>

      <footer className="border-t border-[var(--border)] pb-24 pt-8">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <p className="max-w-[80ch] text-[12px] leading-relaxed text-[var(--text-subtle)]">{t('footer')}</p>
        </div>
      </footer>
    </div>
  );
}
