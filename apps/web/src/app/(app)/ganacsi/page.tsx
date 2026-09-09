import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { env } from '@flt/config';
import { listAllOfferedMarkets } from '@flt/core/services/perps';
import { perpVenues } from '@flt/providers';

export const dynamic = 'force-dynamic';

/**
 * The terminal, not a list — and open to a signed-out visitor.
 *
 * This was a list page, which meant clicking "Trade" produced two risk
 * notices, an empty-state box and a table — with the actual trading screen a
 * further click away and below the fold. Nobody opens a derivatives tab to
 * read a table; they open it to see a market.
 *
 * The list it replaced carried nothing the terminal does not. The ticker strip
 * already holds the market switcher, and the funding, leverage and open
 * interest figures that were columns sit on the instrument header. So this
 * redirects rather than duplicating them.
 *
 * No `requireUserPage()` here: the terminal itself renders in full for a
 * guest, with the order controls locked and a banner explaining why — see
 * `[symbol]/page.tsx`.
 *
 * ## Which market
 *
 * Whatever you were last looking at, then BTC, then whatever is listed. This
 * used to redirect to `markets[0]`, which is an arbitrary position in a query
 * result — so opening the terminal dropped you on whichever symbol happened to
 * sort first, and coming back after a reload lost your place.
 *
 * The last market is a cookie rather than localStorage because this redirect
 * happens on the server, before any client code runs. A stale or hand-edited
 * cookie is checked against the offered list and ignored if it does not match,
 * so it can never route somebody to a market this deployment does not list.
 */
// Not exported: a Next page module may only export its own reserved names.
const LAST_MARKET_COOKIE = 'flt.last-market';

/** The fallback when there is no history to go on. */
const DEFAULT_SYMBOL = 'BTC';

export default async function GanacsiIndexPage() {
  if (!env().PERPS_ENABLED) notFound();

  const markets = await listAllOfferedMarkets(perpVenues());

  // Nothing enabled is a real state, and the market page says so properly
  // rather than this bouncing into a redirect with nowhere to land.
  if (markets.length === 0) notFound();

  const remembered = (await cookies()).get(LAST_MARKET_COOKIE)?.value;

  const chosen =
    markets.find((market) => market.symbol === remembered) ??
    markets.find((market) => market.symbol === DEFAULT_SYMBOL) ??
    markets[0]!;

  redirect(`/ganacsi/${chosen.symbol}`);
}
