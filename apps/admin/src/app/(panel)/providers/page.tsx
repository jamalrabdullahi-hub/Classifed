import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { env } from '@flt/config';
import { Badge, Card, Notice, SectionHeader, TBody, TD, TH, THead, TR, Table } from '@flt/ui';
import { PERMISSIONS, can } from '@flt/core/services/admin';
import { ToggleControl } from '@/components/toggle-control';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'DEX providers' };
export const dynamic = 'force-dynamic';

/**
 * Routing providers.
 *
 * Disabling the active provider makes quoting fail closed rather than falling
 * back to another venue. That is deliberate: refusing to quote is safer than
 * quoting from somewhere an operator has judged unsafe.
 */
export default async function ProvidersPage() {
  const admin = await requireAdminPage();
  const providers = await prisma.dexProvider.findMany({ orderBy: { slug: 'asc' } });
  const active = env().DEX_ROUTER;
  const editable = can(admin, PERMISSIONS.MANAGE_PROVIDERS);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="DEX providers"
        description="Routing venues. The active provider is set by configuration; these switches gate it at runtime."
      />

      <Notice tone="neutral">
        <span className="font-medium">Active provider: {active}</span>. Disabling it stops all
        quoting — the system fails closed rather than routing somewhere unapproved.
      </Notice>

      <Card>
        <Table>
          <THead>
            <TR>
              <TH>Provider</TH>
              <TH>Slug</TH>
              <TH>Chains</TH>
              <TH>Status</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {providers.map((provider) => (
              <TR key={provider.id}>
                <TD>
                  <span className="font-medium">{provider.name}</span>
                  {provider.slug === active ? (
                    <Badge tone="accent" className="ml-2">
                      Active
                    </Badge>
                  ) : null}
                </TD>
                <TD>
                  <code className="font-mono text-[12px] text-[var(--text-muted)]">
                    {provider.slug}
                  </code>
                </TD>
                <TD>{provider.supportedChainIds.join(', ')}</TD>
                <TD>
                  {provider.isEnabled ? (
                    <Badge tone="positive">Enabled</Badge>
                  ) : (
                    <div>
                      <Badge tone="negative">Disabled</Badge>
                      {provider.disabledReason ? (
                        <span className="mt-1 block text-[11px] text-[var(--text-subtle)]">
                          {provider.disabledReason}
                        </span>
                      ) : null}
                    </div>
                  )}
                </TD>
                <TD>
                  {editable ? (
                    <ToggleControl
                      endpoint={`/api/providers/${provider.id}`}
                      enabled={provider.isEnabled}
                      label={provider.name}
                      kind="provider"
                    />
                  ) : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
