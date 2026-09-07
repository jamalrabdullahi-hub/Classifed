import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, KeyRound, Route, ShieldCheck, Wallet } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Button } from '@flt/ui';
import { Wordmark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme';
import { LanguageSwitcher } from '@/components/language-switcher';
import { env } from '@flt/config';
import { currentUser } from '@/server/session';

/**
 * Landing page.
 *
 * Written to set the expectation the product has to meet: this is not an
 * exchange that holds your money. The custody model is the headline rather than
 * a footnote, because a user who does not understand it will be confused by
 * every screen that follows.
 *
 * No price tickers, no volume counters, no urgency. Those belong to a different
 * kind of product.
 */
export default async function HomePage() {
  const user = await currentUser();
  if (user) redirect('/dashboard');

  const perpsEnabled = env().PERPS_ENABLED;
  const t = await getTranslations('landing');

  const stepIcons = [Wallet, Route, KeyRound, ShieldCheck] as const;
  const steps = t.raw('steps') as { title: string; body: string }[];
  const dontDoItems = t.raw('dontDoItems') as string[];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--border)]">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Wordmark />
          <div className="flex items-center gap-3">
            <LanguageSwitcher className="hidden sm:inline-flex" />
            <ThemeToggle className="hidden sm:inline-flex" />
            <Button asChild variant="ghost" size="sm">
              <Link href="/login">{t('signIn')}</Link>
            </Button>
            <Button asChild variant="primary" size="sm">
              <Link href="/register">{t('openAccount')}</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <section className="relative overflow-hidden border-b border-[var(--border)]">
          <div className="grid-texture absolute inset-0 opacity-[0.35]" aria-hidden="true" />

          <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
            <p className="text-[13px] font-medium uppercase tracking-[0.12em] text-[var(--accent-text)]">
              {t('eyebrow')}
            </p>

            <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-[-0.03em] text-[var(--text)] sm:text-5xl">
              {t('title')}
            </h1>

            <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-[var(--text-muted)]">
              {t('subtitle')}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild variant="primary" size="lg">
                <Link href="/register">
                  {t('openAccount')}
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild variant="secondary" size="lg">
                <Link href="/login">{t('signIn')}</Link>
              </Button>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-[13px] font-medium uppercase tracking-[0.12em] text-[var(--text-subtle)]">
            {t('howItWorks')}
          </h2>

          <ol className="mt-8 grid gap-px overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
            {steps.map(({ title, body }, index) => {
              const Icon = stepIcons[index] ?? stepIcons[0];
              const step = String(index + 1).padStart(2, '0');
              return (
                <li key={step} className="bg-[var(--surface)] p-6">
                  <div className="flex items-center gap-2.5">
                    <Icon className="size-4 text-[var(--accent)]" aria-hidden="true" />
                    <span className="num text-[11px] font-medium tracking-[0.08em] text-[var(--text-subtle)]">
                      {step}
                    </span>
                  </div>
                  <h3 className="mt-3 text-sm font-semibold text-[var(--text)]">{title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">{body}</p>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="border-t border-[var(--border)] bg-[var(--surface-sunken)]">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="text-2xl font-semibold tracking-[-0.02em] text-[var(--text)]">
                {t('whatWeDontDoTitle')}
              </h2>
              <p className="mt-3 text-[14px] leading-relaxed text-[var(--text-muted)]">
                {t('whatWeDontDoIntro')}
                {/* Tied to the flag rather than written as a fixed claim. This
                    sentence has now been wrong in both directions: it once said
                    leverage was not offered after perpetuals were built, and
                    saying they are available while the feature is switched off
                    would be just as untrue. */}
                {perpsEnabled ? <> {t('perpsAddendum')}</> : null}
              </p>
            </div>

            <ul className="space-y-3 text-[13px] leading-relaxed text-[var(--text-muted)]">
              {dontDoItems.map((item) => (
                <li key={item} className="flex gap-3">
                  <span
                    className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--text-subtle)]"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--border)] py-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 sm:px-6">
          <Wordmark />
          <p className="max-w-2xl text-[12px] leading-relaxed text-[var(--text-subtle)]">
            {t('disclaimer')}
          </p>
        </div>
      </footer>
    </div>
  );
}
