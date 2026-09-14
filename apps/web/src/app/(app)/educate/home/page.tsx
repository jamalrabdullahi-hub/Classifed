import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { BookOpen } from 'lucide-react';
import { LearnLessons, lessonTitles } from '@/components/learn/lessons';
import { requireUserPage } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('educate'))('title') };
}

/**
 * Lessons, signed in — ftlexchange.com/educate/home.
 *
 * The same lessons as the public Learn site. This page may carry one
 * advertisement for FTL Exchange because the reader already has an account here;
 * it is the exchange advertising on its own property, not the acquisition path.
 *
 * Rules for that ad, kept on purpose:
 *   - one card, clearly labelled as an advertisement;
 *   - placed after the lessons, never the first thing on the page;
 *   - never opens by itself and never blocks a lesson;
 *   - it goes to Account → Trading, where trading is a separate application
 *     (identity verification and review), never to a trading screen.
 */
export default async function EducateHomePage() {
  await requireUserPage();
  const t = await getTranslations('educate');
  const lessons = await lessonTitles();

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <div className="max-w-2xl">
        <p className="text-[12px] font-medium uppercase tracking-[0.12em] text-[var(--accent-text)]">FTL Learn</p>
        <h1 className="mt-2 text-[28px] font-semibold tracking-[-0.02em] text-[var(--text)]">{t('title')}</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--text-muted)]">{t('intro')}</p>
      </div>

      <nav aria-label={t('lessonsLabel')}>
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {lessons.map(({ id, title }, index) => (
            <li key={id}>
              <a
                href={`#${id}`}
                className="flex h-full items-start gap-2.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-3.5 hover:border-[var(--border-strong)]"
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

      {/* The one advertisement on this page. After the lessons, labelled, never blocking. */}
      <aside
        aria-label={t('ad.label')}
        className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-sunken)] p-5"
      >
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">{t('ad.label')}</p>
        <div className="mt-2 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <BookOpen className="mt-0.5 size-4 shrink-0 text-[var(--text-subtle)]" aria-hidden="true" />
            <div>
              <p className="text-[14px] font-semibold text-[var(--text)]">{t('ad.title')}</p>
              <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-[var(--text-muted)]">{t('ad.body')}</p>
            </div>
          </div>
          <Link
            href="/akoon#trading"
            className="shrink-0 rounded-[var(--radius-md)] border border-[var(--border-strong)] px-3.5 py-2 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--surface-hover)]"
          >
            {t('ad.cta')}
          </Link>
        </div>
      </aside>
    </div>
  );
}
