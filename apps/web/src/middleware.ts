import { NextResponse, type NextRequest } from 'next/server';

/**
 * Host routing for Learn, plus the request path for server layouts.
 *
 * learn.ftlexchange.com is a separate educational site. On that host the root
 * is rewritten to `/baro` and every other page path redirects back to the
 * root, so nothing of the exchange is reachable through it. On the exchange's
 * own domain, `/baro` redirects to the Learn host rather than living in two
 * places.
 *
 * Nothing here gates or hides the exchange: signed-out visitors and crawlers
 * see the same site on ftlexchange.com that anybody else does.
 */

const LEARN_HOST = 'learn.ftlexchange.com';
const LEARN_PATH = '/baro';

const STATIC_FILES = /^\/(favicon\.ico|icon\.svg|icon-\d+\.png|maskable-\d+\.png|apple-icon\.png|og\.png|robots\.txt|sitemap\.xml|manifest\.webmanifest)$/;

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = (request.headers.get('host') ?? '').split(':')[0]?.toLowerCase() ?? '';

  if (host === LEARN_HOST) {
    if (pathname === '/') {
      const url = request.nextUrl.clone();
      url.pathname = LEARN_PATH;
      return NextResponse.rewrite(url);
    }
    if (STATIC_FILES.test(pathname)) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url, 308);
  }

  if (pathname === LEARN_PATH && host.endsWith('ftlexchange.com')) {
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
