import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SectionHeader } from '@flt/ui';
import { agentStatusFor, agenticTradingOperational } from '@flt/core/services/agent-trading';
import { requireUserPage } from '@/server/session';
import { AgentPanel } from './agent-panel';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleAgent') };
}
export const dynamic = 'force-dynamic';

/**
 * The AI trading agent's settings.
 *
 * Not public, unlike the terminal and the plans page: this is the one screen
 * on the platform where FLT ends up holding a signing key, and that is not a
 * decision to let someone half-configure before they have an account.
 */
export default async function AgentPage() {
  const user = await requireUserPage();
  const t = await getTranslations('agentPage');
  const status = await agentStatusFor(user);

  return (
    <div className="space-y-6">
      <SectionHeader title={t('title')} description={t('description')} />
      <AgentPanel
        operational={agenticTradingOperational()}
        eligible={status.eligible}
        agent={
          status.agent
            ? {
                status: status.agent.status,
                allocatedUsdHyperliquid: status.agent.allocatedUsdHyperliquid,
                allocatedUsdOstium: status.agent.allocatedUsdOstium,
                maxLeverage: status.agent.maxLeverage,
                symbols: status.agent.symbols.split(','),
                killSwitchReason: status.agent.killSwitchReason,
              }
            : null
        }
        keys={status.keys.map((key) => ({
          venueSlug: key.venueSlug,
          address: key.address,
          authorized: key.authorizedAt !== null,
        }))}
      />
    </div>
  );
}
