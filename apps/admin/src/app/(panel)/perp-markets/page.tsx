import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { env } from '@flt/config';
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  SectionHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@flt/ui';
import { PERMISSIONS, can } from '@flt/core/services/admin';
import { ToggleControl } from '@/components/toggle-control';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Perpetual markets' };
export const dynamic = 'force-dynamic';

/**
 * The perpetual market registry.
 *
 * Two caps are shown side by side deliberately. The venue's is a fact about the
 * market; FLT's is a decision about what to offer, and seeing them together is
 * the only way to tell whether that decision has actually been made or merely
 * inherited.
 *
 * A global ceiling sits above both. Whatever a market is set to, no order is
 * accepted above PERP_MAX_LEVERAGE.
 */
export default async function PerpMarketsPage() {
  const admin = await requireAdminPage();
  const config = env();

  const markets = await prisma.perpMarket.findMany({
    orderBy: [{ isEnabled: 'desc' }, { symbol: 'asc' }],
  });

  const editable = can(admin, PERMISSIONS.MANAGE_TOKENS);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Perpetual markets"
        description="Markets offered for leveraged trading. Disabling one removes it from the interface and refuses new orders immediately."
      />

      {!config.PERPS_ENABLED ? (
        <Notice tone="warning" title="Perpetuals are switched off for this deployment">
          PERPS_ENABLED is false, so none of these markets are reachable by users regardless of
          whether they are enabled here.
        </Notice>
      ) : null}

      <Notice tone="neutral" title={`Global leverage ceiling: ${config.PERP_MAX_LEVERAGE}x`}>
        No order is accepted above this, whatever an individual market is set to. Change it with
        PERP_MAX_LEVERAGE and restart.
      </Notice>

      <Card>
        {markets.length === 0 ? (
          <EmptyState
            title="No perpetual markets"
            description="Markets are added by seeding or by an operator, and are disabled until explicitly enabled."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Market</TH>
                <TH>Venue</TH>
                <TH numeric>FLT cap</TH>
                <TH numeric>Venue max</TH>
                <TH numeric>Min size</TH>
                <TH>Status</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {markets.map((market) => (
                <TR key={market.id}>
                  <TD>
                    <span className="font-medium">{market.symbol}</span>
                    <span className="block text-[11px] text-[var(--text-subtle)]">
                      {market.name}
                    </span>
                  </TD>
                  <TD>{market.venueSlug}</TD>
                  <TD numeric>
                    <span className="num">
                      {Math.min(market.maxLeverage, config.PERP_MAX_LEVERAGE)}x
                    </span>
                    {market.maxLeverage > config.PERP_MAX_LEVERAGE ? (
                      <span className="block text-[11px] text-[var(--text-subtle)]">
                        set to {market.maxLeverage}x, capped globally
                      </span>
                    ) : null}
                  </TD>
                  <TD numeric>
                    <span className="num text-[var(--text-muted)]">
                      {market.venueMaxLeverage}x
                    </span>
                  </TD>
                  <TD numeric>
                    <span className="num">{market.minSize}</span>
                  </TD>
                  <TD>
                    {market.isEnabled ? (
                      <Badge tone="neutral">Enabled</Badge>
                    ) : (
                      <div>
                        <Badge tone="negative">Disabled</Badge>
                        {market.disabledReason ? (
                          <span className="mt-1 block text-[11px] text-[var(--text-subtle)]">
                            {market.disabledReason}
                          </span>
                        ) : null}
                      </div>
                    )}
                  </TD>
                  <TD>
                    {editable ? (
                      <ToggleControl
                        endpoint={`/api/perp-markets/${market.id}`}
                        enabled={market.isEnabled}
                        label={`${market.symbol} perpetual`}
                        kind="token"
                      />
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
