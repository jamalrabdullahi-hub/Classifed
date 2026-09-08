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
 */
export default async function GanacsiIndexPage() {
  if (!env().PERPS_ENABLED) notFound();

  const markets = await listAllOfferedMarkets(perpVenues());
  const first = markets[0];

  // Nothing enabled is a real state, and the market page says so properly
  // rather than this bouncing into a redirect with nowhere to land.
  if (!first) notFound();

  redirect(`/ganacsi/${first.symbol}`);
}
