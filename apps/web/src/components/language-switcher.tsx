'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@flt/ui';
import { LOCALE_COOKIE, type Locale } from '@/i18n/locale';

/**
 * EN / SO, a plain toggle rather than a dropdown.
 *
 * Two languages don't need a menu — a menu is friction the choice doesn't
 * earn. The cookie is set for a year and read on the next request by
 * `resolveLocale`; `router.refresh()` re-renders the current route server-side
 * in the new language without a full navigation.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const locale = useLocale() as Locale;
  const router = useRouter();
  const t = useTranslations('nav');

  function choose(next: Locale) {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
    router.refresh();
  }

  return (
    <div
      role="group"
      aria-label={t('language')}
      className={cn(
        'inline-flex items-center rounded-[var(--radius-md)] border border-[var(--border)] p-0.5 text-[11px] font-medium',
        className,
      )}
    >
      {(['en', 'so'] as const).map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => choose(code)}
          aria-pressed={locale === code}
          className={cn(
            'rounded-[3px] px-2 py-1 uppercase tracking-[0.04em] transition-colors',
            locale === code
              ? 'bg-[var(--surface-hover)] text-[var(--text)]'
              : 'text-[var(--text-subtle)] hover:text-[var(--text)]',
          )}
        >
          {code}
        </button>
      ))}
    </div>
  );
}
