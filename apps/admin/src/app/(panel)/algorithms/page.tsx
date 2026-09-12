import type { Metadata } from 'next';
import { env } from '@flt/config';
import { Badge, Notice, SectionHeader } from '@flt/ui';
import { listAllAlgorithms } from '@flt/core/services/algorithms';
import { AlgorithmEditor } from '@/components/algorithm-editor';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Algorithms' };
export const dynamic = 'force-dynamic';

/**
 * The algorithm catalog.
 *
 * The runner warning is the point of this page as much as the editors are: an
 * operator can publish and price an algorithm while ALGORITHMS_ENABLED is off,
 * and nothing will trade. That mismatch is invisible everywhere else, so it is
 * stated on the screen where the catalog is managed.
 */
export default async function AlgorithmsPage() {
  const admin = await requireAdminPage();
  const config = env();
  const canEdit = admin.role === 'SUPER_ADMIN' || admin.role === 'OPERATOR';
  const algorithms = await listAllAlgorithms();

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Algorithms"
        description="Strategy templates participants buy and the worker runs automatically. Every order an algorithm places is subject to the same leverage, insurance and balance checks as a manual trade."
      />

      <div className="flex flex-wrap gap-2">
        <Badge tone="neutral">{algorithms.filter((algorithm) => algorithm.isActive).length} active</Badge>
        <Badge tone={config.ALGORITHMS_ENABLED ? 'positive' : 'warning'}>
          Runner {config.ALGORITHMS_ENABLED ? 'on' : 'off'}
        </Badge>
        <Badge tone="neutral">Platform cap {config.PERP_MAX_LEVERAGE}x</Badge>
      </div>

      {!config.ALGORITHMS_ENABLED ? (
        <Notice tone="warning" title="The runner is switched off">
          ALGORITHMS_ENABLED is not set, so no algorithm places orders. Purchases are recorded and the catalog can be
          built, but nothing trades until the flag is turned on and the worker restarted.
        </Notice>
      ) : null}

      {!canEdit ? (
        <Notice tone="warning" title="Read only">
          Only an operator may change the algorithm catalog.
        </Notice>
      ) : null}

      <AlgorithmEditor
        canEdit={canEdit}
        platformMaxLeverage={config.PERP_MAX_LEVERAGE}
        algorithms={algorithms.map((algorithm) => ({
          id: algorithm.id,
          slug: algorithm.slug,
          name: algorithm.name,
          description: algorithm.description,
          strategy: algorithm.strategy,
          params: (algorithm.params ?? {}) as Record<string, unknown>,
          symbols: algorithm.symbols,
          maxLeverage: algorithm.maxLeverage,
          maxNotionalUsd: algorithm.maxNotionalUsd,
          priceUsd: algorithm.priceUsd,
          periodDays: algorithm.periodDays,
          isActive: algorithm.isActive,
          isFeatured: algorithm.isFeatured,
        }))}
      />
    </div>
  );
}
