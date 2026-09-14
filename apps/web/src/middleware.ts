import { NextResponse, type NextRequest } from 'next/server';

/**
 * The public surface is the wallet page, and nothing else.
 *
 * A visitor without a session — a person arriving from an ad, a link preview,
 * a crawler — can reach `/guriga` (the wallet landing), the sign-in and
 * recovery screens, and the legal pages. Everything else redirects to
 * `/guriga`, and every API outside sign-in answers 401.
 *
 * This only checks that a session cookie is *present*: the edge runtime has no
 * database. It is a gate for the signed-out surface, not the authorisation
 * check — every page and route still resolves the session itself, so a forged
 * cookie reaches nothing more than the existing redirect to `/gal`.
 *
 * Every response except the landing carries `X-Robots-Tag: noindex`, so what a
 * crawler may index is exactly the page it is allowed to see.
 */

const SESSION_COOKIE = 'flt_session';
const LANDING = '/guriga';

const PUBLIC_PAGES = [
  LANDING,
  '/gal',
  '/is-diiwaan-geli',
  '/dib-u-deji',
  '/beddel-furaha',
  '/xaqiiji-iimaylka',
  '/suspended',
  '/privacy',
  '/terms',
  '/delete-account',
  '/app',
];

const PUBLIC_API = ['/api/auth/', '/api/assetlinks'];

const PUBLIC_FILES = [
  '/.well-known/',
  '/downloads/',
  '/robots.txt',
  '/sitemap.xml',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/maskable-512.png',
  '/apple-icon.png',
  '/og.png',
];

function matches(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) =>
    prefix.endsWith('/')
      ? pathname.startsWith(prefix) || pathname === prefix.slice(0, -1)
      : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function withRobots(response: NextResponse, pathname: string): NextResponse {
  if (pathname !== LANDING) response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const signedIn = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  const isPublic =
    matches(pathname, PUBLIC_PAGES) || matches(pathname, PUBLIC_API) || matches(pathname, PUBLIC_FILES);

  if (signedIn || isPublic) return withRobots(NextResponse.next(), pathname);

  if (pathname.startsWith('/api/')) {
    return withRobots(
      NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' } },
        { status: 401 },
      ),
      pathname,
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = LANDING;
  url.search = '';
  return withRobots(NextResponse.redirect(url, 307), pathname);
}

export const config = {
  // Next's own build output never needs a session.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
