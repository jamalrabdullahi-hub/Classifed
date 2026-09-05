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
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Fees' };
export const dynamic = 'force-dynamic';

/**
 * Fee configuration.
 *
 * Rules resolve most-specific-first: (chain, token) beats (chain), which beats
 * (account type), which beats the global default. Priority breaks ties among
 * equally specific rules, which is what lets a promotional override sit
 * alongside the rule it overrides rather than replacing it.
 */
export default async function FeesPage() {
  await requireAdminPage();

  const configs = await prisma.feeConfig.findMany({
    orderBy: [{ isEnabled: 'desc' }, { priority: 'desc' }],
  });

  const recipient = env().FLT_FEE_RECIPIENT_ADDRESS;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Fees"
        description="Resolved most-specific-first: chain and token, then chain, then account type, then the default."
      />

      {!recipient ? (
        <Notice tone="warning" title="No fee recipient configured">
          FLT_FEE_RECIPIENT_ADDRESS is not set, so every quote resolves to zero regardless of the
          rules below. There is nowhere for a fee to go.
        </Notice>
      ) : null}

      <Card>
        {configs.length === 0 ? (
          <EmptyState title="No fee rules" description="Every quote resolves to zero." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Type</TH>
                <TH numeric>Rate</TH>
                <TH>Applies to</TH>
                <TH numeric>Priority</TH>
                <TH>Window</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {configs.map((config) => (
                <TR key={config.id}>
                  <TD>{config.name}</TD>
                  <TD>
                    <Badge tone="neutral">{config.feeType}</Badge>
                  </TD>
                  <TD numeric>
                    {config.feeType === 'PERCENTAGE'
                      ? `${((config.bps ?? 0) / 100).toFixed(2)}%`
                      : (config.fixedAmount ?? '—')}
                  </TD>
                  <TD>
                    <span className="text-[12px] text-[var(--text-muted)]">
                      {[
                        config.chainId ? `chain ${config.chainId}` : null,
                        config.tokenAddress ? 'specific token' : null,
                        config.accountType ?? null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Everything'}
                    </span>
                  </TD>
                  <TD numeric>{config.priority}</TD>
                  <TD>
                    <span className="text-[12px] text-[var(--text-muted)]">
                      {config.validFrom || config.validUntil
                        ? `${config.validFrom?.toLocaleDateString() ?? '—'} to ${
                            config.validUntil?.toLocaleDateString() ?? '—'
                          }`
                        : 'Always'}
                    </span>
                  </TD>
                  <TD>
                    {config.isEnabled ? (
                      <Badge tone="positive">Enabled</Badge>
                    ) : (
                      <Badge tone="neutral">Disabled</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">
        The aggregator accepts basis points only, so a fixed fee is converted at quote time and both
        the intended and the applied rate are recorded on the quote. Fees are capped at 1000 basis
        points, which is the aggregator&apos;s own limit.
      </p>
    </div>
  );
}
