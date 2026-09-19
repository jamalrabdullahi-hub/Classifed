import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ThemeToggle } from '@/components/theme';
import { LEARN_ARTICLES, findLearnArticle } from '@/content/learn-articles';

const LEARN_ORIGIN = 'https://learn.ftlexchange.com';
const EXCHANGE_URL = 'https://ftlexchange.com/signup';

export function generateStaticParams() {
  return LEARN_ARTICLES.map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const article = findLearnArticle((await params).slug);
  if (!article) return {};
  const url = `${LEARN_ORIGIN}/${article.slug}`;
  return {
    title: { absolute: article.title },
    description: article.description,
    keywords: article.keywords,
    applicationName: 'FTL Learn',
    robots: { index: true, follow: true },
    alternates: { canonical: url, languages: { so: url } },
    openGraph: {
      type: 'article',
      locale: 'so_SO',
      siteName: 'FTL Learn',
      title: article.title,
      description: article.description,
      url,
      modifiedTime: article.updated,
    },
    twitter: { card: 'summary', title: article.title, description: article.description },
  };
}

/**
 * One FTL Learn article — learn.ftlexchange.com/<slug>.
 *
 * Somali, server-rendered, one question per page, with Article and FAQPage
 * structured data so search engines can show it as an answer. Other articles
 * are linked at the foot, and one labelled FTL Exchange advertisement follows
 * the article, never before it.
 */
export default async function LearnArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const article = findLearnArticle((await params).slug);
  if (!article) notFound();

  const url = `${LEARN_ORIGIN}/${article.slug}`;
  const others = LEARN_ARTICLES.filter((entry) => entry.slug !== article.slug);

  const structured = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: article.title,
      description: article.description,
      inLanguage: 'so',
      dateModified: article.updated,
      mainEntityOfPage: url,
      publisher: { '@type': 'Organization', name: 'FTL Learn', url: LEARN_ORIGIN },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      inLanguage: 'so',
      mainEntity: article.faq.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'FTL Learn', item: `${LEARN_ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: article.title, item: url },
      ],
    },
  ];

  return (
    <div lang="so" className="flex min-h-screen flex-col bg-[var(--canvas)]">
      <script
        type="application/ld+json"
        // Built from our own content file, not user input.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structured) }}
      />

      <header className="border-b border-[var(--border)]">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <a href={`${LEARN_ORIGIN}/`} className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text)]">
            FTL Learn
          </a>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <nav aria-label="Breadcrumb" className="text-[12px] text-[var(--text-subtle)]">
          <a href={`${LEARN_ORIGIN}/`} className="hover:text-[var(--text)]">
            FTL Learn
          </a>{' '}
          / <span>{article.title}</span>
        </nav>

        <article className="mt-4">
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-[var(--text)] [text-wrap:balance] sm:text-[34px]">
            {article.title}
          </h1>
          <p className="mt-4 text-[16px] leading-relaxed text-[var(--text-muted)]">{article.intro}</p>

          {article.sections.map((section) => (
            <section key={section.heading} className="mt-8">
              <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-[var(--text)]">{section.heading}</h2>
              {section.body.map((paragraph) => (
                <p key={paragraph} className="mt-3 text-[15px] leading-relaxed text-[var(--text-muted)]">
                  {paragraph}
                </p>
              ))}
            </section>
          ))}

          <section className="mt-10">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-[var(--text)]">Su&apos;aalaha badanaa la is weydiiyo</h2>
            <dl className="mt-4 space-y-4">
              {article.faq.map((item) => (
                <div key={item.q} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4">
                  <dt className="text-[15px] font-semibold text-[var(--text)]">{item.q}</dt>
                  <dd className="mt-1.5 text-[14px] leading-relaxed text-[var(--text-muted)]">{item.a}</dd>
                </div>
              ))}
            </dl>
          </section>

          <p className="mt-8 text-[12px] leading-relaxed text-[var(--text-subtle)]">
            Waxbarasho oo keliya. Talo maaliyadeed maaha. Crypto wuxuu leeyahay khatar, oo ay ku jirto lumitaanka lacagta aad geliso.
          </p>
        </article>

        <aside
          aria-label="Xayeysiis · FTL Exchange"
          className="mt-10 rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-sunken)] p-5"
        >
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--text-subtle)]">
            Xayeysiis · FTL Exchange
          </p>
          <div className="mt-2 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-[52ch] text-[13.5px] leading-relaxed text-[var(--text-muted)]">
              FTL Exchange waa badeecad kale. Lacag ku dar EVC, bangi ama PayPal; ganacsiguna wuxuu u baahan yahay codsi gaar ah.
            </p>
            <a
              href={EXCHANGE_URL}
              className="shrink-0 whitespace-nowrap rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-2 text-[13px] font-semibold text-[var(--text-inverse)] hover:bg-[var(--accent-hover)]"
            >
              Fur akoon FTL
            </a>
          </div>
        </aside>

        <nav aria-label="Maqaallo kale" className="mt-10">
          <h2 className="text-[15px] font-semibold text-[var(--text)]">Maqaallo kale</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {others.map((entry) => (
              <li key={entry.slug}>
                <a
                  href={`${LEARN_ORIGIN}/${entry.slug}`}
                  className="block rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3 text-[13.5px] text-[var(--text)] hover:border-[var(--border-strong)]"
                >
                  {entry.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </main>

      <footer className="border-t border-[var(--border)] py-8">
        <div className="mx-auto max-w-3xl px-4 text-[12px] leading-relaxed text-[var(--text-subtle)] sm:px-6">
          FTL Learn waa badeecad waxbarasho. Ganacsigu waa badeecad kale oo u baahan codsi u gaar ah.
        </div>
      </footer>
    </div>
  );
}
