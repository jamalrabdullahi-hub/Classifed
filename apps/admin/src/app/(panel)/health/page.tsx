import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { env } from '@flt/config';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DetailRow,
  SectionHeader,
  StatusPill,
} from '@flt/ui';
import { custodyProvider, dexRouter, marketDataProvider, perpVenue } from '@flt/providers';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'System health' };
export const dynamic = 'force-dynamic';

/**
 * System health.
 *
 * Each dependency is checked live on page load rather than read from a cached
 * status. A health page that is itself stale is worse than none — it produces
 * confident green ticks during an outage.
 */
export default async function HealthPage() {
  await requireAdminPage();
  const config = env();

  const custody = custodyProvider();
  const perps = config.PERPS_ENABLED ? perpVenue() : null;

  const [database, router, market, perpsHealth, staleQuotes, openTransactions, lastMarketFetch] =
    await Promise.all([
      checkDatabase(),
      dexRouter()
        .health()
        .catch((error: unknown) => ({ ok: false, detail: String(error) })),
      marketDataProvider()
        .health()
        .catch((error: unknown) => ({ ok: false, detail: String(error) })),
      perps
        ? perps.health().catch((error: unknown) => ({ ok: false, detail: String(error) }))
        : Promise.resolve({ ok: true, detail: 'Perpetuals disabled' }),
      prisma.quote.count({ where: { status: 'ACTIVE', expiresAt: { lt: new Date() } } }),
      prisma.transaction.count({ where: { status: { in: ['SUBMITTED', 'PENDING'] } } }),
      prisma.marketDataCache.findFirst({
        orderBy: { fetchedAt: 'desc' },
        select: { fetchedAt: true },
      }),
    ]);

  // Expired quotes that were never swept are the clearest signal the worker is
  // not running — it is the job that sweeps them.
  const workerHealthy = staleQuotes === 0;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="System health"
        description="Checked live on each page load, so a green tick means the dependency answered just now."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <HealthCard name="Database" ok={database.ok} detail={database.detail} />
        <HealthCard
          name={`DEX router · ${config.DEX_ROUTER}`}
          ok={router.ok}
          detail={router.detail}
        />
        <HealthCard
          name={`Market data · ${config.MARKET_DATA_PROVIDER}`}
          ok={market.ok}
          detail={market.detail}
        />
        <HealthCard
          name={`Custody · ${config.CUSTODY_PROVIDER}`}
          ok={custody !== null}
          detail={
            custody
              ? `omnibus ${config.OMNIBUS_EVM_ADDRESS ?? 'not configured'}`
              : 'not configured — no omnibus, no custody'
          }
        />
        {perps ? (
          <HealthCard
            name={`Perps venue · ${config.PERP_VENUE}`}
            ok={perpsHealth.ok}
            detail={perpsHealth.detail}
          />
        ) : null}
        <HealthCard
          name="Worker"
          ok={workerHealthy}
          detail={workerHealthy ? 'Sweeping normally' : `${staleQuotes} expired quotes not swept`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <Badge tone={config.NODE_ENV === 'production' ? 'negative' : 'warning'}>
            {config.NODE_ENV}
          </Badge>
        </CardHeader>
        <CardContent className="divide-y divide-[var(--border)]">
          <DetailRow label="DEX router" value={config.DEX_ROUTER} />
          <DetailRow label="Custody provider" value={config.CUSTODY_PROVIDER} />
          <DetailRow
            label="Omnibus"
            value={config.OMNIBUS_EVM_ADDRESS ?? 'Not configured'}
            hint={config.OMNIBUS_EVM_ADDRESS ? undefined : 'Custody cannot operate without one'}
          />
          <DetailRow label="Perpetuals" value={config.PERPS_ENABLED ? `on · ${config.PERP_VENUE}` : 'off'} />
          <DetailRow label="Market data provider" value={config.MARKET_DATA_PROVIDER} />
          <DetailRow label="KYC provider" value={config.KYC_PROVIDER} />
          <DetailRow label="Mail provider" value={config.MAIL_PROVIDER} />
          <DetailRow label="Quote validity" value={`${config.QUOTE_TTL_SECONDS}s`} />
          <DetailRow
            label="Default slippage"
            value={`${(config.DEFAULT_SLIPPAGE_BPS / 100).toFixed(2)}%`}
          />
          <DetailRow
            label="Maximum price impact"
            value={`${(config.MAX_PRICE_IMPACT_BPS / 100).toFixed(2)}%`}
          />
          <DetailRow label="Confirmations required" value={config.WORKER_CONFIRMATIONS} />
          <DetailRow
            label="Fee recipient"
            value={config.FLT_FEE_RECIPIENT_ADDRESS || 'Not configured'}
            hint={config.FLT_FEE_RECIPIENT_ADDRESS ? undefined : 'Fees resolve to zero without one'}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-[var(--border)]">
          <DetailRow label="Transactions in flight" value={openTransactions} />
          <DetailRow label="Expired quotes awaiting sweep" value={staleQuotes} />
          <DetailRow
            label="Market data last refreshed"
            value={lastMarketFetch?.fetchedAt.toLocaleString() ?? 'Never'}
          />
        </CardContent>
      </Card>
    </div>
  );
}

async function checkDatabase(): Promise<{ ok: boolean; detail?: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, detail: 'Responding' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'Unreachable' };
  }
}

function HealthCard({ name, ok, detail }: { name: string; ok: boolean; detail?: string }) {
  return (
    <Card>
      <CardContent className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--text-subtle)]">
          {name}
        </p>
        <StatusPill tone={ok ? 'positive' : 'negative'}>{ok ? 'Healthy' : 'Degraded'}</StatusPill>
        {detail ? (
          <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">{detail}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
