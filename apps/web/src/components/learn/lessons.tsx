import { getTranslations } from 'next-intl/server';
import { Fingerprint, ShieldCheck, Snowflake, Usb } from 'lucide-react';
import {
  ChainDiagram,
  CustodyCompare,
  KeysDiagram,
  ScamGrid,
  StorageSteps,
  TransferChecks,
} from '@/app/baro/infographics';
import { SignDemo } from '@/app/baro/sign-demo';

/**
 * The lessons, shared by the public Learn site (learn.ftlexchange.com) and the
 * signed-in lessons page (ftlexchange.com/educate/home), so the two can never
 * teach different things.
 *
 * Lessons only. Anything else a page wants to show — the signed-in page's one
 * labelled ad — lives on that page, outside this component.
 */

export const LESSON_IDS = ['crypto', 'chain', 'keys', 'storage', 'scams'] as const;

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

/** Lesson titles in order, for a table of contents. */
export async function lessonTitles(): Promise<{ id: (typeof LESSON_IDS)[number]; title: string }[]> {
  const t = await getTranslations('learn');
  return [
    { id: 'crypto', title: t('demo.title') },
    { id: 'chain', title: t('chain.title') },
    { id: 'keys', title: t('keys.title') },
    { id: 'storage', title: t('storage.title') },
    { id: 'scams', title: t('scams.title') },
  ];
}

export async function LearnLessons({ exclude = [] }: { exclude?: (typeof LESSON_IDS)[number][] }) {
  const t = await getTranslations('learn');
  const hardwareIcons = [Snowflake, Usb, Fingerprint];
  const show = (id: (typeof LESSON_IDS)[number]) => !exclude.includes(id);

  return (
    <>
      {show('crypto') ? (
        <Section id="crypto" title={t('demo.title')} intro={t('demo.intro')}>
          <SignDemo />
        </Section>
      ) : null}

      {show('chain') ? (
        <Section id="chain" title={t('chain.title')} intro={t('chain.intro')}>
          <ChainDiagram blocks={t.raw('chain.blocks') as { label: string; body: string }[]} caption={t('chain.caption')} />
          <div className="grid gap-3 md:grid-cols-3">
            {(t.raw('assets') as { title: string; body: string }[]).map((item) => (
              <div key={item.title} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4">
                <h3 className="text-[14px] font-semibold text-[var(--text)]">{item.title}</h3>
                <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-muted)]">{item.body}</p>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {show('keys') ? (
        <Section id="keys" title={t('keys.title')} intro={t('keys.intro')}>
          <KeysDiagram items={t.raw('keys.items') as { title: string; body: string; tag: string; example: string }[]} />
          <CustodyCompare columns={t.raw('keys.custody') as { title: string; summary: string; points: string[] }[]} />
        </Section>
      ) : null}

      {show('storage') ? (
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
      ) : null}

      {show('scams') ? (
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
      ) : null}
    </>
  );
}
