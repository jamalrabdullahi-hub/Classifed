import Link from 'next/link';
import { ArrowDownToLine, KeyRound, Send, ShieldCheck } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Button } from '@flt/ui';
import { Wordmark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme';
import { LanguageSwitcher } from '@/components/language-switcher';
import { LegalLinks } from '@/components/legal-links';

/**
 * The wallet landing — the only page a signed-out visitor or crawler sees.
 *
 * Deliberately bare: what the wallet does (store, receive, send), how the
 * account is protected, and the way in. No prices, no market data, and no link
 * to anything a signed-out visitor could not open anyway.
 */
export async function WalletLanding() {
  const t = await getTranslations('walletLanding');

  const features = [
    { icon: ShieldCheck, title: t('storeTitle'), body: t('storeBody') },
    { icon: ArrowDownToLine, title: t('receiveTitle'), body: t('receiveBody') },
    { icon: Send, title: t('sendTitle'), body: t('sendBody') },
    { icon: KeyRound, title: t('protectTitle'), body: t('protectBody') },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--border)]">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
          <Wordmark />
          <div className="flex items-center gap-3">
            <LanguageSwitcher className="hidden sm:inline-flex" />
            <ThemeToggle />
            <Button asChild variant="ghost" size="sm">
              <Link href="/gal">{t('signIn')}</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-14 sm:px-6 sm:py-20">
        <section className="max-w-2xl">
          <p className="text-[12px] font-medium uppercase tracking-[0.12em] text-[var(--text-subtle)]">
            {t('eyebrow')}
          </p>
          <h1 className="mt-3 text-[32px] font-semibold leading-tight tracking-[-0.02em] text-[var(--text)] sm:text-[42px]">
            {t('title')}
          </h1>
          <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-[var(--text-muted)]">{t('intro')}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild variant="primary">
              <Link href="/is-diiwaan-geli">{t('create')}</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/gal">{t('signIn')}</Link>
            </Button>
          </div>
        </section>

        <section className="mt-16 grid gap-4 sm:grid-cols-2">
          {features.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-5"
            >
              <Icon className="size-5 text-[var(--accent)]" aria-hidden="true" />
              <h2 className="mt-3 text-[15px] font-semibold text-[var(--text)]">{title}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">{body}</p>
            </div>
          ))}
        </section>

        <p className="mt-12 max-w-[70ch] text-[12px] leading-relaxed text-[var(--text-subtle)]">{t('custodyNote')}</p>
      </main>

      <footer className="border-t border-[var(--border)] py-6">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <LegalLinks />
        </div>
      </footer>
    </div>
  );
}
