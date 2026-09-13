import type { Metadata } from 'next';
import { env } from '@flt/config';
import { prisma } from '@flt/db';
import { Badge, Notice, SectionHeader } from '@flt/ui';
import { listAllAlgorithms, listPendingOfferings } from '@flt/core/services/algorithms';
import { AlgorithmEditor } from '@/components/algorithm-editor';
import { OfferingReview, type PendingOffering } from '@/components/offering-review';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Algo trading' };
export const dynamic = 'force-dynamic';

/**
 * The offering catalog and the publish-review queue.
 *
 * FLT's own offerings plus every participant offering; a published one only
 * goes live once approved here, because it trades real money for whoever
 * activates it.
 */
export default async function AlgorithmsPage() {
  const admin = await requireAdminPage();
  const config = env();
  const canEdit = admin.role === 'SUPER_ADMIN' || admin.role === 'OPERATOR';

  const [algorithms, pendingRows] = await Promise.all([listAllAlgorithms(), listPendingOfferings()]);

  const creatorIds = Array.from(
    new Set(pendingRows.map((row) => row.creatorId).filter((id): id is string => Boolean(id))),
  );
  const creators = creatorIds.length
    ? await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, email: true } })
    : [];
  const emailById = new Map(creators.map((creator) => [creator.id, creator.email]));

  const pending: PendingOffering[] = pendingRows.map((row) => ({
    slug: row.slug,
    name: row.name,
    creatorEmail: row.creatorId ? (emailById.get(row.creatorId) ?? null) : null,
    strategyType: row.strategyType,
    symbols: row.symbols,
  }));

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Algo trading"
        description="FLT's offerings and every participant offering. Frictionless — 2%/month of capital, pro-rated daily, taken on exit. A published offering is reviewed before it goes live; its creator earns 50% of the fees."
      />

      <div className="flex flex-wrap gap-2">
        <Badge tone="neutral">{algorithms.filter((a) => a.isActive).length} active</Badge>
        <Badge tone={pending.length > 0 ? 'warning' : 'neutral'}>{pending.length} awaiting review</Badge>
        <Badge tone={config.ALGORITHMS_ENABLED ? 'positive' : 'warning'}>
          Runner {config.ALGORITHMS_ENABLED ? 'on' : 'off'}
        </Badge>
        <Badge tone={config.AI_ENABLED ? 'positive' : 'warning'}>AI {config.AI_ENABLED ? 'on' : 'off'}</Badge>
        <Badge tone="neutral">Platform cap {config.PERP_MAX_LEVERAGE}x</Badge>
      </div>

      {!config.ALGORITHMS_ENABLED ? (
        <Notice tone="warning" title="The runner is switched off">
          ALGORITHMS_ENABLED is not set, so no offering places orders.
        </Notice>
      ) : null}

      <OfferingReview pending={pending} />

      {!canEdit ? (
        <Notice tone="warning" title="Read only">
          Only an operator may change the offering catalog.
        </Notice>
      ) : null}

      <AlgorithmEditor
        canEdit={canEdit}
        platformMaxLeverage={config.PERP_MAX_LEVERAGE}
        algorithms={algorithms.map((algorithm) => ({
          id: algorithm.id,
          slug: algorithm.slug,
          kind: algorithm.kind,
          name: algorithm.name,
          description: algorithm.description,
          strategy: algorithm.strategy,
          symbols: algorithm.symbols,
          maxLeverage: algorithm.maxLeverage,
          maxNotionalUsd: algorithm.maxNotionalUsd,
          managementFeeBps: algorithm.managementFeeBps,
          requiresPro: algorithm.requiresPro,
          systemPrompt: algorithm.systemPrompt,
          promptRails: Array.isArray(algorithm.promptRails)
            ? (algorithm.promptRails as unknown[]).filter((v): v is string => typeof v === 'string')
            : [],
          periodDays: algorithm.periodDays,
          isActive: algorithm.isActive,
          isFeatured: algorithm.isFeatured,
        }))}
      />
    </div>
  );
}
