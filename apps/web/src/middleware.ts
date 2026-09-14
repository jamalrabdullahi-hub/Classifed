import { NextResponse, type NextRequest } from 'next/server';

/**
 * Host routing for Learn and the sign-up funnel.
 *
 * learn.ftlexchange.com serves two pages:
 *   - `/`        → Learn (`/baro`)
 *   - `/signup`  → registration (`/is-diiwaan-geli`), which creates an
 *                  FTLexchange account and continues on ftlexchange.com
 * Every other page path on that host belongs to the exchange and redirects
 * to the same path on ftlexchange.com.
 *
 * On ftlexchange.com, `/signup` redirects to learn.ftlexchange.com/signup and
 * `/baro` to the Learn root, so each page lives at one address. Off the
 * production domain (local development) both are served in place.
 *
 * Nothing here gates or hides the exchange.
 */

const LEARN_HOST = 'learn.ftlexchange.com';
const EXCHANGE_ORIGIN = 'https://ftlexchange.com';
const LEARN_PATH = '/baro';
const SIGNUP_PATH = '/is-diiwaan-geli';

const STATIC_FILES = /^\/(favicon\.ico|icon\.svg|icon-\d+\.png|maskable-\d+\.png|apple-icon\.png|og\.png|robots\.txt|sitemap\.xml|manifest\.webmanifest)$/;

function rewrite(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  return NextResponse.rewrite(url);
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const host = (request.headers.get('host') ?? '').split(':')[0]?.toLowerCase() ?? '';

  if (host === LEARN_HOST) {
    if (pathname === '/') return rewrite(request, LEARN_PATH);
    if (pathname === '/signup') return rewrite(request, SIGNUP_PATH);
    if (STATIC_FILES.test(pathname)) return NextResponse.next();
    return NextResponse.redirect(`${EXCHANGE_ORIGIN}${pathname}${search}`, 308);
  }

  const onExchangeDomain = host.endsWith('ftlexchange.com');

  if (pathname === '/signup') {
    return onExchangeDomain
      ? NextResponse.redirect(`https://${LEARN_HOST}/signup${search}`, 308)
      : rewrite(request, SIGNUP_PATH);
  }
  if (pathname === LEARN_PATH && onExchangeDomain) {
    return NextResponse.redirect(`https://${LEARN_HOST}/`, 308);
  }

  // Layouts cannot read the pathname; `(app)/layout.tsx` needs it for the
  // signed-out wallet landing, which carries its own header.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-flt-path', pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|api/).*)'],
};
