import type { Metadata } from 'next';
import { env } from '@flt/config';
import { Badge, Notice, SectionHeader } from '@flt/ui';
import { listAllAlgorithms } from '@flt/core/services/algorithms';
import { AlgorithmEditor } from '@/components/algorithm-editor';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Algo trading' };
export const dynamic = 'force-dynamic';

/**
 * The offering catalog.
 *
 * Two kinds — Algo (deterministic, everyone) and AI (model-driven, Pro only)
 * — under one fee model. The runner warning is the point of this page as much
 * as the editors are: an operator can publish and price an offering while
 * ALGORITHMS_ENABLED is off, and nothing will trade.
 */
export default async function AlgorithmsPage() {
  const admin = await requireAdminPage();
  const config = env();
  const canEdit = admin.role === 'SUPER_ADMIN' || admin.role === 'OPERATOR';
  const algorithms = await listAllAlgorithms();

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Algo trading"
        description="Offerings participants activate to trade their allocated capital. Frictionless — 2%/month of capital, pro-rated daily, taken on exit. Every order is subject to the same leverage, insurance and balance checks as a manual trade."
      />

      <div className="flex flex-wrap gap-2">
        <Badge tone="neutral">{algorithms.filter((a) => a.isActive).length} active</Badge>
        <Badge tone={config.ALGORITHMS_ENABLED ? 'positive' : 'warning'}>
          Runner {config.ALGORITHMS_ENABLED ? 'on' : 'off'}
        </Badge>
        <Badge tone={config.AI_ENABLED ? 'positive' : 'warning'}>
          AI {config.AI_ENABLED ? 'on' : 'off'}
        </Badge>
        <Badge tone="neutral">Platform cap {config.PERP_MAX_LEVERAGE}x</Badge>
      </div>

      {!config.ALGORITHMS_ENABLED ? (
        <Notice tone="warning" title="The runner is switched off">
          ALGORITHMS_ENABLED is not set, so no offering places orders. The catalog can be built, but nothing trades
          until the flag is on and the worker restarted.
        </Notice>
      ) : null}

      {!config.AI_ENABLED ? (
        <Notice tone="warning" title="AI trading is switched off">
          AI_ENABLED is not set (or AI_API_KEY is missing), so the AI offering cannot be activated. The Algo offering is
          unaffected.
        </Notice>
      ) : null}

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
