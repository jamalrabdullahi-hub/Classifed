import { recommendReduction } from '@flt/core/services/protection-policies';
import { assertPerpsEnabled } from '@flt/core/services/perps';
import { perpVenue } from '@flt/providers';
import { routeHandler } from '@/server/api';
import { PROTECTION_DISCLOSURE } from '@/server/protection';

/**
 * The minimum reduction that restores compliance (§7, §18).
 *
 * §15 names this `/reduce` and §7 describes automatic reduction when a
 * participant cannot fund a shortfall. This endpoint computes and records the
 * reduction; it does not perform it, and it never will from this server. No
 * key capable of closing a position exists here — the agent key that can
 * submit orders is generated in the browser, kept in session storage, and
 * never transmitted. Automatic reduction is not unimplemented; it is
 * impossible by construction, which is a property worth keeping.
 *
 * So the response is advice with the arithmetic attached: how much notional to
 * close, roughly how many contracts that is at the current mark, and what the
 * policy state became as a result.
 */
export const POST = routeHandler<unknown, { id: string }, unknown>(
  {},
  async ({ params, user }) => {
    assertPerpsEnabled();

    const advice = await recommendReduction(perpVenue(), params.id, user!);

    return {
      ...advice,
      disclosure: PROTECTION_DISCLOSURE,
    };
  },
);
