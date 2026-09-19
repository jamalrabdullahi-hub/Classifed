import { NextResponse, type NextRequest } from 'next/server';
import { LEARN_ARTICLE_SLUGS } from '@/content/learn-articles';

/**
 * Host routing, and the exchange's sign-in wall.
 *
 * ## learn.ftlexchange.com
 *
 * The educational site. Its root is rewritten to `/baro`, and each Somali
 * article lives at `/<slug>` (served by `/baro/<slug>`). Any other path on
 * that host redirects to the same path on ftlexchange.com.
 *
 * ## ftlexchange.com
 *
 * Signed out, a visitor can reach sign-in, sign-up, password recovery, email
 * confirmation and the legal pages. Every other page redirects to sign-in and
 * every API outside `/api/auth` answers 401. This checks only that a session
 * cookie is present — the edge has no database — so every page and route still
 * resolves the session itself.
 */

const LEARN_HOST = 'learn.ftlexchange.com';
const EXCHANGE_ORIGIN = 'https://ftlexchange.com';
const SESSION_COOKIE = 'flt_session';

const STATIC_FILES = /^\/(favicon\.ico|icon\.svg|icon-\d+\.png|maskable-\d+\.png|apple-icon\.png|og\.png|robots\.txt|sitemap\.xml|manifest\.webmanifest)$/;

const PUBLIC_PAGES = [
  '/',
  // The terminal is the exchange's front page: a signed-out visitor sees it
  // blurred behind a sign-in prompt (`TradingLock`), and can do nothing on it.
  '/ganacsi',
  '/baro',
  '/gal',
  '/signup',
  '/is-diiwaan-geli',
  '/dib-u-deji',
  '/beddel-furaha',
  '/xaqiiji-iimaylka',
  '/privacy',
  '/terms',
  '/delete-account',
  '/app',
];

const PUBLIC_PREFIXES = [
  '/api/auth/',
  '/api/assetlinks',
  '/.well-known/',
  '/downloads/',
  '/baro/',
  // Ad creatives, shown on Learn and linked from campaigns.
  '/ads/',
  '/ganacsi/',
  // Public market data the blurred terminal draws with. Read-only.
  '/api/perps/markets',
];

/**
 * Marks a request as Learn, so the root layout ships only Learn's own text to
 * the browser — not the exchange's message catalogue.
 */
function learnHeaders(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  headers.set('x-flt-surface', 'learn');
  return headers;
}

function isPublic(pathname: string): boolean {
  return (
    PUBLIC_PAGES.includes(pathname) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    STATIC_FILES.test(pathname)
  );
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const host = (request.headers.get('host') ?? '').split(':')[0]?.toLowerCase() ?? '';

  if (host === LEARN_HOST) {
    if (pathname === '/') {
      const url = request.nextUrl.clone();
      url.pathname = '/baro';
      return NextResponse.rewrite(url, { request: { headers: learnHeaders(request) } });
    }
    if (STATIC_FILES.test(pathname) || pathname.startsWith('/ads/')) return NextResponse.next();
    // Articles live at learn.ftlexchange.com/<slug>, served by /baro/<slug>.
    const slug = pathname.slice(1);
    if (LEARN_ARTICLE_SLUGS.includes(slug)) {
      const url = request.nextUrl.clone();
      url.pathname = `/baro/${slug}`;
      return NextResponse.rewrite(url, { request: { headers: learnHeaders(request) } });
    }
    return NextResponse.redirect(`${EXCHANGE_ORIGIN}${pathname}${search}`, 308);
  }

  if (pathname.startsWith('/baro/')) {
    // One address per article: the Learn host.
    if (host.endsWith('ftlexchange.com')) {
      return NextResponse.redirect(`https://${LEARN_HOST}/${pathname.slice('/baro/'.length)}`, 308);
    }
    return NextResponse.next({ request: { headers: learnHeaders(request) } });
  }

  if (pathname === '/baro') {
    if (host.endsWith('ftlexchange.com')) return NextResponse.redirect(`https://${LEARN_HOST}/`, 308);
    // Local development serves Learn in place.
    return NextResponse.next({ request: { headers: learnHeaders(request) } });
  }

  const signedIn = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (!signedIn && !isPublic(pathname)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' } },
        { status: 401 },
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = '/gal';
    url.search = '';
    return NextResponse.redirect(url, 307);
  }

  // Sign-up is FTL Learn's page on either address; the auth layout reads this.
  if (pathname === '/signup' || pathname === '/is-diiwaan-geli') {
    const headers = new Headers(request.headers);
    headers.set('x-flt-surface', 'signup');
    if (pathname === '/is-diiwaan-geli') return NextResponse.next({ request: { headers } });
    const url = request.nextUrl.clone();
    url.pathname = '/is-diiwaan-geli';
    return NextResponse.rewrite(url, { request: { headers } });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
