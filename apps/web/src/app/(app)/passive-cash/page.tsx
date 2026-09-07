import type { Metadata } from 'next';
import { SectionHeader } from '@flt/ui';
import { passiveCashSummary } from '@flt/core/services/passive-cash';
import { requireUserPage } from '@/server/session';
import { PassiveCashPanel } from '@/components/passive-cash-panel';

export const metadata: Metadata = { title: 'Passive cash' };
export const dynamic = 'force-dynamic';

/**
 * Passive cash.
 *
 * Its own page rather than a row in settings. This is the one place where money
 * leaves the participant's wallet and FLT holds it, which is the opposite of
 * what the rest of the product promises — it deserves a destination somebody
 * arrives at deliberately, not a switch they meet while looking for something
 * else.
 */
export default async function PassiveCashPage() {
  const user = await requireUserPage();
  const summary = await passiveCashSummary(user.id);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Passive cash"
        description="Let idle cash work in FLT's market-making, for half the profit. You bear the losses."
      />

      <PassiveCashPanel
        isEnabled={summary.isEnabled}
        balance={summary.balance}
        lifetimeEarned={summary.lifetimeEarned}
        lifetimeLost={summary.lifetimeLost}
        profitSharePct={summary.profitSharePct}
        lossSharePct={summary.lossSharePct}
        needsReacceptance={summary.needsReacceptance}
        disclosureVersion={summary.disclosureVersion}
        disclosurePoints={summary.disclosurePoints}
        operational={summary.operational}
        entries={summary.recentEntries.map((entry) => ({
          kind: entry.kind,
          amount: entry.amount,
          balanceAfter: entry.balanceAfter,
          reason: entry.reason,
          createdAt: entry.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
