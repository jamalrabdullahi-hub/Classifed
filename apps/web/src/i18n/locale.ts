/**
 * Locale constants shared by client and server code.
 *
 * Split out of `request.ts` because that module imports `next/headers` and is
 * server-only — a client component (`LanguageSwitcher`) importing it for just
 * `LOCALE_COOKIE` would pull `next/headers` into the browser bundle and fail
 * the build.
 */
export const LOCALE_COOKIE = 'flt_locale';
export const LOCALES = ['en', 'so'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'en' || value === 'so';
}
