import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from './locale';

/**
 * Somali and English, cookie-selected — not URL-prefixed.
 *
 * The route tree (`(app)`, `(auth)`) predates this and every internal link,
 * API route and redirect assumes an unprefixed path. Prefixing routes with a
 * locale segment would touch every one of those. A cookie carries the choice
 * instead: `resolveLocale` below is the one place that decides which language
 * a request gets. The locale values themselves live in `./locale.ts` — a
 * client-safe module, since this one imports `next/headers` and cannot be
 * imported from client components.
 *
 * Only the trading platform (`apps/web`) is bilingual. The admin console is
 * an internal tool for FLT operators, not participants, and stays English —
 * it never imports this module.
 */
export { LOCALE_COOKIE, LOCALES, DEFAULT_LOCALE, isLocale, type Locale } from './locale';

export async function resolveLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;

  // No explicit choice yet: honour the browser's language header once, so a
  // Somali-speaking visitor's first render is already in Somali rather than
  // waiting on them to find the switcher.
  const acceptLanguage = (await headers()).get('accept-language') ?? '';
  if (acceptLanguage.toLowerCase().includes('so')) return 'so';

  return DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  const messages = (await import(`../../messages/${locale}.json`)).default;
  return { locale, messages };
});
