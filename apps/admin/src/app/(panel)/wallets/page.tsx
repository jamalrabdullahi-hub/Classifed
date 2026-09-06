import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@flt/db';
import {
  AddressChip,
  Badge,
  Card,
  EmptyState,
  Input,
  SectionHeader,
  StatusPill,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@flt/ui';
import { explorerAddressUrl } from '@flt/core/chains';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Wallets' };
export const dynamic = 'force-dynamic';

/**
 * Linked wallets across all accounts.
 *
 * Searchable by address, because that is how an investigation usually starts:
 * someone supplies an address and asks whose it is.
 */
export default async function AdminWalletsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireAdminPage();
  const params = await searchParams;
  const query = params.q?.trim() ?? '';

  const wallets = await prisma.wallet.findMany({
    where: query ? { address: { contains: query, mode: 'insensitive' } } : {},
    include: { user: { select: { id: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take: 150,
  });

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Wallets"
        description="Every address linked to an account, and the account it belongs to."
      />

      <form method="get" className="flex gap-2">
        <Input
          name="q"
          defaultValue={query}
          placeholder="Search by address"
          className="min-w-0 flex-1"
          aria-label="Search wallets by address"
        />
        <button
          type="submit"
          className="rounded-[var(--radius-md)] bg-[var(--accent)] px-4 text-[13px] font-medium text-white"
        >
          Search
        </button>
      </form>

      <Card>
        {wallets.length === 0 ? (
          <EmptyState title="No wallets found" description="Nothing matches that search." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Address</TH>
                <TH>Account</TH>
                <TH>Status</TH>
                <TH>Connector</TH>
                <TH numeric>Linked</TH>
              </TR>
            </THead>
            <TBody>
              {wallets.map((wallet) => (
                <TR key={wallet.id}>
                  <TD>
                    <AddressChip
                      address={wallet.address}
                      explorerUrl={explorerAddressUrl(wallet.chainId, wallet.address)}
                    />
                  </TD>
                  <TD>
                    <Link
                      href={`/users/${wallet.user.id}`}
                      className="text-[13px] link"
                    >
                      {wallet.user.email}
                    </Link>
                  </TD>
                  <TD>
                    {wallet.verifiedAt ? (
                      <StatusPill tone="positive">Verified</StatusPill>
                    ) : (
                      <StatusPill tone="neutral">Unlinked</StatusPill>
                    )}
                  </TD>
                  <TD>
                    <Badge tone="neutral">{wallet.connector ?? 'unknown'}</Badge>
                  </TD>
                  <TD numeric>
                    <span className="text-[12px] text-[var(--text-muted)]">
                      {wallet.createdAt.toLocaleDateString()}
                    </span>
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
