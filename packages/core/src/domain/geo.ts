/**
 * Where FLT serves customers, and what everyone else may see.
 *
 * The probes that created the throwaway accounts came from Hong Kong and
 * mainland China, where FLT has no customers and no licence to operate. Rather
 * than chase individual addresses, the exchange's *interactive* surface — the
 * sign-in and sign-up pages, every API, every signed-in screen — is served only
 * to the countries FLT actually serves: the Horn of Africa, the Gulf, and the
 * diaspora countries.
 *
 * Reading is not restricted. The Learn site, its Somali articles, the legal
 * pages and the Android download page stay open to every country, because
 * search engines crawl from everywhere and losing them would cost more than the
 * probes do. Someone outside the list sees the pages and gets nowhere by
 * clicking.
 *
 * The country comes from Cloudflare's `CF-IPCountry` header, which the origin
 * cannot be lied to about: the edge sets it, and nginx only forwards what
 * Cloudflare sent. With no header (local development, a direct origin request)
 * nothing is blocked — the header's absence is not evidence of a country, and
 * the sign-in wall and rate limits still apply.
 */

/** ISO 3166-1 alpha-2, uppercase. */
export const SERVED_COUNTRIES: readonly string[] = [
  // Horn of Africa and east Africa
  'SO', 'KE', 'ET', 'DJ', 'UG', 'TZ', 'SS', 'EG',
  // Gulf Cooperation Council
  'SA', 'AE', 'KW', 'QA', 'BH', 'OM',
  // Turkey and the Levant routes the diaspora uses
  'TR', 'JO', 'LB',
  // Europe: the Somali diaspora
  'SE', 'NO', 'DK', 'FI', 'GB', 'NL', 'DE', 'CH', 'IE', 'BE', 'AT', 'IT', 'FR',
  // North America and Oceania
  'US', 'CA', 'AU', 'NZ',
];

const SERVED = new Set(SERVED_COUNTRIES);

/**
 * True when the request may use the interactive product.
 *
 * Unknown (`null`, `XX`, `T1` for Tor) is treated as *not* served: a visitor
 * Cloudflare cannot place does not get the sign-up form, but still reads the
 * public pages.
 */
export function isServedCountry(country: string | null | undefined): boolean {
  if (!country) return true; // No Cloudflare header: local or direct origin.
  const code = country.trim().toUpperCase();
  if (code === 'XX' || code === 'T1') return false;
  return SERVED.has(code);
}

/** The visitor's country as Cloudflare reports it, or null. */
export function requestCountry(headers: Headers): string | null {
  return headers.get('cf-ipcountry');
}

/**
 * Paths everyone may read, whatever their country: the Learn site and its
 * articles, the legal pages, the app download, and the files search engines
 * and the Android app fetch.
 */
export function isWorldReadablePath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/baro' || pathname.startsWith('/baro/')) return true;
  if (pathname === '/ganacsi' || pathname.startsWith('/ganacsi/')) return true;
  if (['/privacy', '/terms', '/delete-account', '/app'].includes(pathname)) return true;
  if (pathname.startsWith('/ads/') || pathname.startsWith('/downloads/')) return true;
  if (pathname.startsWith('/.well-known/') || pathname.startsWith('/api/assetlinks')) return true;
  // Read-only market data the public terminal draws with.
  if (pathname.startsWith('/api/perps/markets')) return true;
  return /^\/(favicon\.ico|icon\.svg|icon-\d+\.png|maskable-\d+\.png|apple-icon\.png|og\.png|robots\.txt|sitemap\.xml|manifest\.webmanifest)$/.test(
    pathname,
  );
}
