import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Fingerprint, Info, Snowflake, Usb, ShieldCheck } from 'lucide-react';
import { Button } from '@flt/ui';
import { ThemeToggle } from '@/components/theme';
import { LanguageSwitcher } from '@/components/language-switcher';
import {
  ChainDiagram,
  CustodyCompare,
  HeroEmblem,
  KeysDiagram,
  ScamGrid,
  StorageSteps,
  TransferChecks,
} from './infographics';
import { SignDemo } from './sign-demo';

const CANONICAL = 'https://learn.ftlexchange.com/';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('learn.meta');
  return {
    title: { absolute: t('title') },
    description: t('description'),
    applicationName: 'Learn',
    robots: { index: true, follow: true },
    alternates: { canonical: CANONICAL },
    openGraph: { type: 'article', title: t('title'), description: t('description'), url: CANONICAL, siteName: 'Learn' },
    twitter: { card: 'summary', title: t('title'), description: t('description') },
  };
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 space-y-5 border-t border-[var(--border)] pt-12">
      <div className="max-w-2xl">
        <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-[var(--text)] [text-wrap:balance]">{title}</h2>
        {intro ? <p className="mt-2 text-[14px] leading-relaxed text-[var(--text-muted)]">{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Learn — learn.ftlexchange.com.
 *
 * A separate educational site: how public-key cryptography and blockchains
 * work, how to store digital assets and keys safely, hardware security keys,
 * and how to recognise scams. It has no accounts, sells nothing and links to
 * nothing on FLTexchange, and it says so at the top and the bottom.
 */
export default async function LearnPage() {
  const t = await getTranslations('learn');

  const toc = [
    ['crypto', t('demo.title')],
    ['chain', t('chain.title')],
    ['keys', t('keys.title')],
    ['storage', t('storage.title')],
    ['scams', t('scams.title')],
  ] as const;

  const hardwareIcons = [Snowflake, Usb, Fingerprint];

  return (
    <div className="flex min-h-screen flex-col bg-[var(--canvas)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--canvas)]/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text)]">Learn</span>
          <nav aria-label={t('tocLabel')} className="hidden items-center gap-5 text-[13px] md:flex">
            {toc.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="text-[var(--text-muted)] hover:text-[var(--text)]">
                {label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <LanguageSwitcher className="hidden sm:inline-flex" />
            <ThemeToggle />
            <Button asChild variant="primary" size="sm">
              <a href="/signup">{t('cta.label')}</a>
            </Button>
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

        <aside
          role="note"
          className="flex gap-3 rounded-[var(--radius-lg)] border border-[var(--info-border)] bg-[var(--info-subtle)] p-4"
        >
          <Info className="mt-0.5 size-4 shrink-0 text-[var(--info)]" aria-hidden="true" />
          <div>
            <p className="text-[13.5px] font-semibold text-[var(--text)]">{t('separate.title')}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">{t('separate.body')}</p>
          </div>
        </aside>

        <Section id="crypto" title={t('demo.title')} intro={t('demo.intro')}>
          <SignDemo />
        </Section>

        <Section id="chain" title={t('chain.title')} intro={t('chain.intro')}>
          <ChainDiagram
            blocks={t.raw('chain.blocks') as { label: string; body: string }[]}
            caption={t('chain.caption')}
          />
          <div className="grid gap-3 md:grid-cols-3">
            {(t.raw('assets') as { title: string; body: string }[]).map((item) => (
              <div key={item.title} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4">
                <h3 className="text-[14px] font-semibold text-[var(--text)]">{item.title}</h3>
                <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-muted)]">{item.body}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section id="keys" title={t('keys.title')} intro={t('keys.intro')}>
          <KeysDiagram items={t.raw('keys.items') as { title: string; body: string; tag: string; example: string }[]} />
          <CustodyCompare columns={t.raw('keys.custody') as { title: string; summary: string; points: string[] }[]} />
        </Section>

        <Section id="storage" title={t('storage.title')} intro={t('storage.intro')}>
          <div className="grid gap-3 md:grid-cols-3">
            {(t.raw('hardware.items') as { title: string; body: string }[]).map((item, index) => {
              const Icon = hardwareIcons[index] ?? ShieldCheck;
              return (
                <div key={item.title} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5">
                  <Icon className="size-5 text-[var(--accent)]" aria-hidden="true" />
                  <h3 className="mt-3 text-[15px] font-semibold text-[var(--text)]">{item.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">{item.body}</p>
                </div>
              );
            })}
          </div>
          <div className="grid gap-10 pt-4 lg:grid-cols-[1fr_1fr]">
            <StorageSteps steps={t.raw('storage.steps') as { title: string; body: string }[]} />
            <div className="space-y-3">
              <h3 className="text-[15px] font-semibold text-[var(--text)]">{t('storage.checksTitle')}</h3>
              <TransferChecks checks={t.raw('storage.checks') as { title: string; body: string }[]} />
            </div>
          </div>
        </Section>

        <Section id="scams" title={t('scams.title')} intro={t('scams.intro')}>
          <ScamGrid items={t.raw('scams.items') as { title: string; how: string; flag: string }[]} flagLabel={t('scams.flagLabel')} />
          <div className="rounded-[var(--radius-lg)] border border-[var(--accent-border)] bg-[var(--accent-subtle)] p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-[var(--accent)]" aria-hidden="true" />
              <h3 className="text-[15px] font-semibold text-[var(--text)]">{t('rules.title')}</h3>
            </div>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {(t.raw('rules.items') as string[]).map((rule) => (
                <li key={rule} className="text-[13px] leading-relaxed text-[var(--text-muted)]">
                  {rule}
                </li>
              ))}
            </ul>
          </div>
        </Section>
        <section className="flex flex-col items-start gap-4 rounded-[var(--radius-xl)] border border-[var(--accent-border)] bg-[var(--surface)] p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div className="max-w-xl">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-[var(--text)]">{t('cta.title')}</h2>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--text-muted)]">{t('cta.body')}</p>
          </div>
          <div className="flex flex-col items-start gap-1.5 sm:items-end">
            <Button asChild variant="primary">
              <a href="/signup">{t('cta.label')}</a>
            </Button>
            <p className="text-[11.5px] text-[var(--text-subtle)]">{t('cta.note')}</p>
          </div>
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
