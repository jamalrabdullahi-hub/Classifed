import type { Metadata } from 'next';
import { prisma } from '@flt/db';
import { AddressChip, Badge, Card, SectionHeader, TBody, TD, TH, THead, TR, Table } from '@flt/ui';
import { explorerTokenUrl } from '@flt/core/chains';
import { PERMISSIONS, can } from '@flt/core/services/admin';
import { ToggleControl } from '@/components/toggle-control';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Tokens' };
export const dynamic = 'force-dynamic';

/**
 * The token registry.
 *
 * Disabling a token removes it from the trade screen and from quoting
 * immediately. The schema requires a reason for a disabled token, so the
 * refusal can be explained to a user rather than failing silently.
 */
export default async function TokensPage() {
  const admin = await requireAdminPage();
  const tokens = await prisma.token.findMany({
    orderBy: [{ isEnabled: 'desc' }, { symbol: 'asc' }],
  });

  const editable = can(admin, PERMISSIONS.MANAGE_TOKENS);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Tokens"
        description="Disabling a token removes it from markets and refuses new quotes for it immediately."
      />

      <Card>
        <Table>
          <THead>
            <TR>
              <TH>Token</TH>
              <TH>Contract</TH>
              <TH numeric>Decimals</TH>
              <TH>Tier</TH>
              <TH>Status</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {tokens.map((token) => (
              <TR key={token.id}>
                <TD>
                  <span className="font-medium">{token.symbol}</span>
                  <span className="block text-[11px] text-[var(--text-subtle)]">{token.name}</span>
                </TD>
                <TD>
                  <AddressChip
                    address={token.address}
                    explorerUrl={explorerTokenUrl(token.chainId, token.address)}
                  />
                </TD>
                <TD numeric>{token.decimals}</TD>
                <TD>
                  <Badge
                    tone={
                      token.verificationTier === 'VERIFIED'
                        ? 'positive'
                        : token.verificationTier === 'RECOGNIZED'
                          ? 'neutral'
                          : 'warning'
                    }
                  >
                    {token.verificationTier}
                  </Badge>
                </TD>
                <TD>
                  {token.isEnabled ? (
                    <Badge tone="positive">Enabled</Badge>
                  ) : (
                    <div>
                      <Badge tone="negative">Disabled</Badge>
                      {token.disabledReason ? (
                        <span className="mt-1 block text-[11px] text-[var(--text-subtle)]">
                          {token.disabledReason}
                        </span>
                      ) : null}
                    </div>
                  )}
                </TD>
                <TD>
                  {editable ? (
                    <ToggleControl
                      endpoint={`/api/tokens/${token.id}`}
                      enabled={token.isEnabled}
                      label={token.symbol}
                      kind="token"
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
