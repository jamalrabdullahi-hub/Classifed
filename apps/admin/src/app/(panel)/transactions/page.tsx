import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma, type Prisma } from '@flt/db';
import { ShieldAlert } from 'lucide-react';
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  SectionHeader,
  StatusPill,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  truncateMiddle,
} from '@flt/ui';
import { explorerTxUrl } from '@flt/core/chains';
import { requireAdminPage } from '@/server/session';

export const metadata: Metadata = { title: 'Transactions' };
export const dynamic = 'force-dynamic';

/**
 * All transactions.
 *
 * `?flagged=1` narrows to those whose mined calldata did not match the quote
 * FLT issued. That is the view an operator reaches from the dashboard alert,
 * and it is the one that matters most.
 */
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ flagged?: string; status?: string }>;
}) {
  await requireAdminPage();
  const params = await searchParams;

  const flaggedOnly = params.flagged === '1';

  const where: Prisma.TransactionWhereInput = {
    ...(flaggedOnly ? { tamperDetected: true } : {}),
    ...(params.status ? { status: params.status as never } : {}),
  };

  const transactions = await prisma.transaction.findMany({
    where,
    include: { user: { select: { email: true, id: true } } },
    orderBy: { submittedAt: 'desc' },
    take: 150,
  });

  return (
    <div className="space-y-6">
      <SectionHeader
        title={flaggedOnly ? 'Flagged transactions' : 'Transactions'}
        description={
          flaggedOnly
            ? 'The calldata mined on-chain differs from what FLT quoted.'
            : 'Every transaction signed through FLT, and what the chain did with it.'
        }
        action={
          flaggedOnly ? (
            <Link href="/transactions" className="text-[13px] text-[var(--accent)] hover:underline">
              Show all
            </Link>
          ) : (
            <Link
              href="/transactions?flagged=1"
              className="text-[13px] text-[var(--accent)] hover:underline"
            >
              Show flagged only
            </Link>
          )
        }
      />

      {flaggedOnly && transactions.length > 0 ? (
        <Notice tone="negative" icon={<ShieldAlert className="size-4" />} title="Investigate before assuming a client bug">
          A mismatch means the transaction attributed to a quote is not the transaction that quote
          described. FLT cannot undo it — the record exists so it can be investigated.
        </Notice>
      ) : null}

      <Card>
        {transactions.length === 0 ? (
          <EmptyState
            title={flaggedOnly ? 'Nothing flagged' : 'No transactions'}
            description={
              flaggedOnly
                ? 'Every mined transaction has matched the quote it was issued against.'
                : 'No trades have been signed yet.'
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>User</TH>
                <TH>Type</TH>
                <TH>Hash</TH>
                <TH>Status</TH>
                <TH numeric>Block</TH>
                <TH numeric>Submitted</TH>
              </TR>
            </THead>
            <TBody>
              {transactions.map((transaction) => (
                <TR key={transaction.id}>
                  <TD>
                    <Link
                      href={`/users/${transaction.user.id}`}
                      className="text-[13px] text-[var(--accent)] hover:underline"
                    >
                      {transaction.user.email}
                    </Link>
                  </TD>
                  <TD>
                    <Badge tone={transaction.kind === 'SWAP' ? 'accent' : 'neutral'}>
                      {transaction.kind === 'SWAP' ? 'Swap' : 'Approval'}
                    </Badge>
                  </TD>
                  <TD>
                    <a
                      href={explorerTxUrl(transaction.chainId, transaction.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="num font-mono text-[12px] text-[var(--accent)] hover:underline"
                    >
                      {truncateMiddle(transaction.txHash, 10, 8)}
                    </a>
                  </TD>
                  <TD>
                    {transaction.tamperDetected ? (
                      <StatusPill tone="negative">Mismatch</StatusPill>
                    ) : transaction.status === 'CONFIRMED' ? (
                      <StatusPill tone="positive">Confirmed</StatusPill>
                    ) : transaction.status === 'REVERTED' ? (
                      <StatusPill tone="negative">Reverted</StatusPill>
                    ) : transaction.status === 'DROPPED' ? (
                      <StatusPill tone="warning">Dropped</StatusPill>
                    ) : (
                      <StatusPill tone="info" pulse>
                        {transaction.status.toLowerCase()}
                      </StatusPill>
                    )}
                  </TD>
                  <TD numeric>
                    <span className="text-[12px] text-[var(--text-muted)]">
                      {transaction.blockNumber?.toString() ?? '—'}
                    </span>
                  </TD>
                  <TD numeric>
                    <span className="text-[12px] text-[var(--text-muted)]">
                      {transaction.submittedAt.toLocaleString()}
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
